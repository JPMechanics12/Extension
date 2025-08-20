import axios from 'axios';
import dayjs from 'dayjs';
import { UCAR_BASE } from '../config.js';

function parseLatLon(token){
  // e.g., 272N -> 27.2; 1276E -> 127.6
  if(!token || typeof token !== 'string') return null;
  const hemi = token.slice(-1);
  const val = Number(token.slice(0, -1));
  if (!Number.isFinite(val)) return null;
  const signed = val / 10 * (hemi in {'S':1,'W':1} ? -1 : 1);
  return signed;
}

function parseLine(line){
  // Example:
  // WP, 18, 2025081906,   , BEST,   0, 272N, 1276E,  30, 1009, ...
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 10) return null;
  const basin = parts[0];
  const num = Number(parts[1]);
  const ymdh = parts[2];
  const time = dayjs(ymdh, 'YYYYMMDDHH').toDate();
  const lat = parseLatLon(parts[6]);
  const lon = parseLatLon(parts[7]);
  const wind = Number(parts[8]);
  const pres = Number(parts[9]);
  if (!Number.isFinite(wind) || lat === null || lon === null) return null;
  return { basin, num, time, lat, lon, wind, pres };
}

export async function fetchBDeckStorm(year, num){
  const nn = String(num).padStart(2,'0');
  const url = `${UCAR_BASE}/${year}/bwp${nn}${year}.dat`;
  try{
    const res = await axios.get(url, { timeout: 15000 });
    const lines = res.data.split(/\r?\n/).filter(Boolean);
    const points = lines.map(parseLine).filter(Boolean);
    return { id: `WP${nn}${year}`, num, year: Number(year), points };
  }catch(err){
    if (err.response && err.response.status === 404) return null;
    // allow other errors to bubble up so user can see
    throw err;
  }
}

// backend/src/parsers/bdeck.js

// --- helpers --------------------------------------------------------------
function toInt(v) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function parseYMDH(ymdh) {
  const s = String(ymdh).trim();
  if (!/^\d{10}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  return new Date(Date.UTC(y, m, d, h, 0, 0, 0));
}

function parseLat(token) {
  // e.g., "272N" -> 27.2 ; "093S" -> -9.3
  const m = /^(\d+)(\d)([NS])$/i.exec(String(token).trim());
  if (!m) return null;
  const deg = Number(m[1]), tenth = Number(m[2]);
  const sgn = m[3].toUpperCase() === 'S' ? -1 : 1;
  return sgn * (deg + tenth / 10);
}

function parseLon(token) {
  // e.g., "1276E" -> 127.6 ; "1567W" -> -156.7
  const m = /^(\d+)(\d)([EW])$/i.exec(String(token).trim());
  if (!m) return null;
  const deg = Number(m[1]), tenth = Number(m[2]);
  const sgn = m[3].toUpperCase() === 'W' ? -1 : 1;
  return sgn * (deg + tenth / 10);
}

// Parse one .dat text into a storm object
function parseBDeckText(text, num, year) {
  const id = `WP${String(num).padStart(2, '0')}${year}`;
  const points = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line) continue;
    // most lines start with "WP,"; keep only basin WP
    if (!line.startsWith('WP')) continue;

    const cols = line.split(',').map(s => s.trim());
    // Expected primary fields:
    // 0=WP, 1=num, 2=YYYYMMDDHH, 6=lat, 7=lon, 8=wind(kt), 9=pres(hPa)
    const ymdh = cols[2];
    const latS = cols[6];
    const lonS = cols[7];
    const wind = toInt(cols[8]);
    const pres = toInt(cols[9]);

    const t = parseYMDH(ymdh);
    const lat = parseLat(latS);
    const lon = parseLon(lonS);
    if (!t || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    points.push({ t, lat, lon, wind, pres });
  }

  points.sort((a, b) => a.t - b.t);
  return { id, num: Number(num), year, points };
}

/**
 * Fetch active/open JTWC b-decks for the given year (WP basin).
 * For 2025+ use UCAR bdecks_open; we probe bwp01..bwp{max}.
 * Non-existing files (404) are skipped.
 */
export async function fetchActiveBDecks(year, max = 60) {
  const base = `https://hurricanes.ral.ucar.edu/repository/data/bdecks_open/${year}`;
  const nums = Array.from({ length: max }, (_, i) => String(i + 1).padStart(2, '0'));

  const storms = [];
  // modest concurrency to keep it quick but gentle
  const BATCH = 8;
  for (let i = 0; i < nums.length; i += BATCH) {
    const slice = nums.slice(i, i + BATCH);
    const tasks = slice.map(async n => {
      const url = `${base}/bwp${n}${year}.dat`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
        if (!res.ok) return;
        const txt = await res.text();
        const storm = parseBDeckText(txt, Number(n), year);
        if (storm.points.length) storms.push(storm);
      } catch {
        // ignore timeouts/network errors; just means this number isn't present
      }
    });
    await Promise.allSettled(tasks);
  }

  storms.sort((a, b) => a.num - b.num);
  return storms;
}
