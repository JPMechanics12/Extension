// backend/src/parsers/bdeck.js
// Working/operational tracks via CARQ and TCVITALS, with b-deck fallback.

import axios from 'axios';
import { UCAR_BASE } from '../config.js';

/* ────────────────────────────────────────────────────────────────────────
   Shared helpers
   ──────────────────────────────────────────────────────────────────────── */

// Keep the last occurrence for each DTG (by file order).
function lastWins(points) {
  const m = new Map();
  for (const p of points) {
    if (!p || !p.t) continue;
    const k = (p.t instanceof Date ? p.t : new Date(p.t)).toISOString();
    m.set(k, p); // last one seen wins
  }
  return [...m.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
}

function toInt(v) {
  const n = Number(String(v ?? '').trim());
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

// "272N" -> 27.2   "093S" -> -9.3   "1276E" -> 127.6   "1567W" -> -156.7
function parseLat(token) {
  const m = /^(\d+)(\d)([NS])$/i.exec(String(token).trim());
  if (!m) return null;
  const deg = Number(m[1]), tenth = Number(m[2]);
  const sgn = m[3].toUpperCase() === 'S' ? -1 : 1;
  return sgn * (deg + tenth / 10);
}
function parseLon(token) {
  const m = /^(\d+)(\d)([EW])$/i.exec(String(token).trim());
  if (!m) return null;
  const deg = Number(m[1]), tenth = Number(m[2]);
  const sgn = m[3].toUpperCase() === 'W' ? -1 : 1;
  return sgn * (deg + tenth / 10);
}
// Generic lat/lon parser used in CARQ/TCVITALS (accepts both lat/lon types)
function parseLatLon(token) {
  if (!token || typeof token !== 'string') return null;
  const hemi = token.slice(-1).toUpperCase();
  const val = Number(token.slice(0, -1));
  if (!Number.isFinite(val)) return null;
  const sgn = (hemi === 'S' || hemi === 'W') ? -1 : 1;
  return (val / 10) * sgn;
}

/* ────────────────────────────────────────────────────────────────────────
   b-deck parsing (BEST only) – kept for explicit b-deck endpoints/fallback
   ──────────────────────────────────────────────────────────────────────── */

// One raw b-deck CSV line → point (BEST only)
function parseBdeckCsvLine(line) {
  // Example: WP, 18, 2025081906,   , BEST,   0, 272N, 1276E,  30, 1009, ...
  const c = line.split(',').map(s => s.trim());
  if (c.length < 10) return null;
  if (c[0] !== 'WP') return null;
  const tech = (c[4] || '').toUpperCase();
  if (tech !== 'BEST') return null;

  const t = parseYMDH(c[2]);
  const lat = parseLat(c[6]);
  const lon = parseLon(c[7]);
  const wind = toInt(c[8]);
  const pres = toInt(c[9]);
  if (!t || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { t, lat, lon, wind, pres };
}

export async function fetchBDeckStorm(year, num) {
  const nn = String(num).padStart(2, '0');
  const url = `${UCAR_BASE}/bdecks_open/${year}/bwp${nn}${year}.dat`;
  try {
    const res = await axios.get(url, { timeout: 15000, responseType: 'text' });
    const raw = res.data.split(/\r?\n/).filter(Boolean);
    const points = lastWins(
      raw.map(parseBdeckCsvLine).filter(Boolean)
    );
    return { id: `WP${nn}${year}`, num: Number(num), year: Number(year), points };
  } catch (err) {
    if (err.response && err.response.status === 404) return null; // not present
    throw err;
  }
}

// Parse a whole .dat (already loaded as text) into a storm object
function parseBDeckText(text, num, year) {
  const id = `WP${String(num).padStart(2, '0')}${year}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const points = lastWins(lines
    .filter(line => line.startsWith('WP'))
    .map(parseBdeckCsvLine)
    .filter(Boolean));
  return { id, num: Number(num), year: Number(year), points };
}

export async function fetchActiveBDecks(year, max = 60) {
  const base = `${UCAR_BASE}/bdecks_open/${year}`;
  const nums = Array.from({ length: max }, (_, i) => String(i + 1).padStart(2, '0'));
  const storms = [];
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
        // ignore timeouts/404s etc.
      }
    });
    await Promise.allSettled(tasks);
  }

  storms.sort((a, b) => a.num - b.num);
  return storms;
}

/* ────────────────────────────────────────────────────────────────────────
   CARQ (operational working track from A-deck)
   ──────────────────────────────────────────────────────────────────────── */

function parseCarqLine(line) {
  // ATCF CSV columns:
  // 0=Basin,1=Num,2=YYYYMMDDHH,3=TECHNUM,4=TECH,5=TAU,6=Lat,7=Lon,8=VMAX,9=MSLP,...
  const p = line.split(',').map(s => s.trim());
  if (p.length < 10) return null;
  if (p[0] !== 'WP') return null;         // West Pacific only
  if ((p[4] || '').toUpperCase() !== 'CARQ') return null;
  if (String(p[5]) !== '0') return null;  // analysis time only

  const t = parseYMDH(p[2]);
  const lat = parseLatLon(p[6]);
  const lon = parseLatLon(p[7]);
  const wind = toInt(p[8]);
  const pres = toInt(p[9]);
  if (!t || lat == null || lon == null) return null;
  return { t, lat, lon, wind, pres, num: toInt(p[1]) };
}

export async function fetchCarqStorm(year, num) {
  const nn = String(num).padStart(2, '0');
  const url = `${UCAR_BASE}/carq/${year}/awp${nn}${year}.dat`;
  const res = await axios.get(url, { timeout: 15000, responseType: 'text' });

  const rawPoints = res.data.split(/\r?\n/)
    .filter(Boolean)
    .map(parseCarqLine)
    .filter(pt => pt && pt.num === Number(num))
    .map(({ num: _drop, ...pt }) => pt);

  const points = lastWins(rawPoints);
  return { id: `WP${nn}${year}`, num: Number(num), year: Number(year), points };
}

/* ────────────────────────────────────────────────────────────────────────
   TCVITALS (heuristic parser)
   ──────────────────────────────────────────────────────────────────────── */

async function tryGetText(url) {
  try {
    const res = await axios.get(url, { timeout: 12000, responseType: 'text' });
    return res.data;
  } catch (e) {
    if (e.response && e.response.status === 404) return null;
    throw e; // bubble other errors
  }
}

function maybeStormMatch(line, year, num) {
  const nn = String(num).padStart(2, '0');
  // Accept if the line mentions WP and either "WPnn", "WPnnYYYY" or ", nn ,"
  const re = new RegExp(`\\bWP0?${nn}\\b|\\bWP0?${nn}${year}\\b|[,\\s]0?${nn}[,\\s]`);
  return /WP/.test(line) && re.test(line);
}

function parseTcvitalsLine(line) {
  // tokens may be comma or whitespace separated
  const toks = line.split(/[,\s]+/).filter(Boolean);

  // DTG
  const dtgTok = toks.find(t => /^\d{10}$/.test(t));
  if (!dtgTok) return null;
  const t = parseYMDH(dtgTok);
  if (!t) return null;

  // Lat/Lon (ATCF-like)
  const latTok = toks.find(t => /^\d{2,3}\d[NS]$/i.test(t));
  const lonTok = toks.find(t => /^\d{3,4}\d[EW]$/i.test(t));
  if (!latTok || !lonTok) return null;
  const lat = parseLatLon(latTok);
  const lon = parseLatLon(lonTok);
  if (lat == null || lon == null) return null;

  // Optional wind/pres (heuristics)
  let wind = null, pres = null;
  for (const tok of toks) {
    const n = Number(tok);
    if (!Number.isFinite(n)) continue;
    if (wind == null && n >= 10 && n <= 200) wind = n;      // plausible kts
    if (pres == null && n >= 850 && n <= 1050) pres = n;    // plausible hPa
  }

  return { t, lat, lon, wind, pres };
}

export async function fetchTcvitalsStorm(year, num) {
  const nn = String(num).padStart(2, '0');
  const candidates = [
    // per-storm guesses
    `${UCAR_BASE}/tcvitals_open/${year}/tcvitals.wp${nn}${year}.dat`,
    `${UCAR_BASE}/tcvitals_open/${year}/tcvitals_wp${nn}${year}.dat`,
    `${UCAR_BASE}/tcvitals/${year}/tcvitals.wp${nn}${year}.dat`,
    // combined files (filter by num)
    `${UCAR_BASE}/tcvitals_open/${year}/combined_tcvitals.${year}`,
    `${UCAR_BASE}/tcvitals_open/${year}/combined_tcvitals.${year}.dat`,
    `${UCAR_BASE}/tcvitals/${year}/combined_tcvitals.${year}`,
    `${UCAR_BASE}/tcvitals/${year}/combined_tcvitals.${year}.dat`,
  ];

  let raw = null, from = null;
  for (const url of candidates) {
    const txt = await tryGetText(url);
    if (txt) { raw = txt; from = url; break; }
  }
  if (!raw) {
    return { id: `WP${nn}${year}`, num: Number(num), year: Number(year), points: [] };
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const filtered = /combined_tcvitals/.test(from)
    ? lines.filter(line => maybeStormMatch(line, year, num))
    : lines;

  const points = lastWins(
    filtered.map(parseTcvitalsLine).filter(Boolean)
  );

  return { id: `WP${nn}${year}`, num: Number(num), year: Number(year), points };
}

/* ────────────────────────────────────────────────────────────────────────
   Convenience – prefer CARQ, then TCVITALS, then b-deck
   ──────────────────────────────────────────────────────────────────────── */

export async function fetchWorkingStorm(year, num) {
  try {
    const carq = await fetchCarqStorm(year, num);
    if (carq.points.length) return { source: 'carq', ...carq };
  } catch (e) {
    // ignore 404; bubble unexpected errors
    if (!(e.response && e.response.status === 404)) throw e;
  }

  const tc = await fetchTcvitalsStorm(year, num);
  if (tc.points.length) return { source: 'tcvitals', ...tc };

  try {
    const b = await fetchBDeckStorm(year, num);
    if (b && b.points.length) return { source: 'bdeck_open', ...b };
  } catch { /* ignore */ }

  return {
    source: 'none',
    id: `WP${String(num).padStart(2, '0')}${year}`,
    num: Number(num),
    year: Number(year),
    points: []
  };
}

/* ────────────────────────────────────────────────────────────────────────
   Enumerate active working storms quickly
   ──────────────────────────────────────────────────────────────────────── */

export async function fetchActiveWorkingStorms(year, max = 60) {
  const storms = [];
  const nums = Array.from({ length: max }, (_, i) => i + 1);
  const BATCH = 8;

  for (let i = 0; i < nums.length; i += BATCH) {
    const slice = nums.slice(i, i + BATCH);
    await Promise.allSettled(slice.map(async n => {
      try {
        const s = await fetchWorkingStorm(year, n);
        if (s.points.length) storms.push(s);
      } catch {
        // ignore non-existent/404
      }
    }));
  }

  storms.sort((a, b) => a.num - b.num);
  return storms;
}
