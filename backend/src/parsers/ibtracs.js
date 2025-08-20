import XLSX from 'xlsx';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import fs from 'fs';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

// Acceptable timestamp formats (UTC)
const DT_FORMATS = [
  'YYYY-MM-DDTHH:mm:ss[Z]',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DD HH:mm',
  'YYYYMMDDHH',
  'M/D/YYYY H:mm',
  'M/D/YYYY HH:mm',
  'MM/DD/YYYY H:mm',
  'MM/DD/YYYY HH:mm',
  'D/M/YYYY H:mm',
  'D/M/YYYY HH:mm'
];

function excelSerialToDateUTC(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000);
}

function parseDateIB(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number' && isFinite(v)) return excelSerialToDateUTC(v);
  const s = String(v).trim();
  for (const f of DT_FORMATS) {
    const d = dayjs.utc(s, f, true);
    if (d.isValid()) return d.toDate();
  }
  const fb = dayjs.utc(s);
  return fb.isValid() ? fb.toDate() : null;
}

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const toStr = (v) => (v == null ? '' : String(v)).trim();

export function loadIBTrACS(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`IBTrACS file not found at: ${filePath}`);
  }
  // XLSX can read CSV or XLSX
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheetName = wb.SheetNames[0];
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });

  // 1) Basic normalization
  let rows = raw.map(r => {
    const season = toNum(r['SEASON']);
    const basin  = toStr(r['BASIN']);
    const nature = toStr(r['NATURE']);
    const time   = parseDateIB(r['ISO_TIME']);

    const lat = toNum(r['USA_LAT'] ?? r['LAT']);
    const lon = toNum(r['USA_LON'] ?? r['LON']);
    const usaWind = toNum(r['USA_WIND']);
    // Treat <=0 as missing
    const presRaw = toNum(r['USA_PRES']);
    const usaPres = (presRaw != null && presRaw > 0) ? presRaw : null;

    const name    = toStr(r['NAME']) || 'UNNAMED';
    const atcf    = toStr(r['USA_ATCF_ID']);
    const sid     = toStr(r['SID']); // if present

    return { season, basin, nature, time, lat, lon, usaWind, usaPres, name, stormId: atcf || sid || '' };
  })
  .filter(r => r.time instanceof Date && !isNaN(r.time))
  .filter(r => r.basin === 'WP' && !['DS','ET'].includes(r.nature));

  // 2) Canonicalize IDs
  //    - Named storms: if any row has a WP id (e.g., WP122024), use that id for ALL rows of that named storm in that season.
  //    - UNNAMED: never merge the whole year; split into segments by time gaps (>24h) so invests stay separate.
  const byNameSeason = new Map();
  for (const r of rows) {
    const key = `${r.name.toUpperCase()}_${r.season || ''}`;
    if (!byNameSeason.has(key)) byNameSeason.set(key, []);
    byNameSeason.get(key).push(r);
  }

  const canonicalIdForGroup = (name, season, list) => {
    // If any WP id exists and name is not UNNAMED, use the most frequent WP id.
    if (name.toUpperCase() !== 'UNNAMED') {
      const counts = new Map();
      for (const r of list) {
        const id = (r.stormId || '').trim();
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
      }
      if (counts.size > 0) {
        return [...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
      }
    }
    return null; // no single canonical id
  };

  const out = [];
  for (const [key, list] of byNameSeason) {
    const [nm, yr] = key.split('_');
    list.sort((a,b)=> a.time - b.time);

    const canon = canonicalIdForGroup(nm, Number(yr), list);
    if (canon) {
      for (const r of list) r.stormId = canon;
      out.push(...list);
    } else {
      // Either UNNAMED or no WP id present: segment by time gaps > 24h
      let seg = [];
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        const prev = i > 0 ? list[i-1] : null;
        const gapHrs = prev ? (cur.time - prev.time) / 36e5 : 0;
        if (!prev || gapHrs <= 24) {
          seg.push(cur);
        } else {
          if (seg.length) {
            const anchor = dayjs.utc(seg[0].time).format('YYYYMMDDHH');
            const segId = (seg.find(x => x.stormId) ? seg.find(x => x.stormId).stormId : `${nm}_${yr}_${anchor}`);
            for (const r of seg) r.stormId = segId;
            out.push(...seg);
          }
          seg = [cur];
        }
      }
      if (seg.length) {
        const anchor = dayjs.utc(seg[0].time).format('YYYYMMDDHH');
        const segId = (seg.find(x => x.stormId) ? seg.find(x => x.stormId).stormId : `${nm}_${yr}_${anchor}`);
        for (const r of seg) r.stormId = segId;
        out.push(...seg);
      }
    }
  }

  // 3) De-duplicate exact time duplicates per storm (keep first)
  const keep = [];
  const seen = new Set();
  for (const r of out) {
    const id = (r.stormId || '').trim() || `${r.name}_${r.season}`;
    const key = `${id}|${r.time.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push({ ...r, stormId: id });
  }

  return keep;
}

export function filterWP(rows) { return rows; }

export function groupByStorm(rows, year) {
  const map = new Map();
  for (const r of rows) {
    if (year && r.season !== Number(year)) continue;
    const key = r.stormId || `${(r.name || 'UNNAMED').toUpperCase()}_${r.season || 'NA'}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  for (const [k, arr] of map) arr.sort((a,b)=> a.time - b.time);
  return map;
}
