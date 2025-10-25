// backend/src/routes/api.js
import express from 'express';
import fs from 'fs';

import { IBTRACS_PATH, DEFAULT_YEAR } from '../config.js';
import { loadIBTrACS, filterWP, groupByStorm } from '../parsers/ibtracs.js';
import {
   fetchActiveBDecks,           // keep (explicit b-deck)
   fetchActiveWorkingStorms,    // NEW: CARQ→TCVITALS→bdeck for all storms
   fetchWorkingStorm            // NEW: single-storm CARQ→TCVITALS→bdeck
 } from '../parsers/bdeck.js';
import {
  computeACEByMonth, computeStormSummaries,
  computeCategoryDays, computePARMonthlyEntries, computeStormsFormedByMonth,
  computeACEYTD, computeACEYTDMonthlyCum, computeACEYTDClimo,
  computeACEDaily, computeACEDailyClimo,
  insidePAR   // <— add this
} from '../services/metrics.js';


const MS_PER_DAY = 24 * 60 * 60 * 1000;

const router = express.Router();

const numFromId = (id) => {
  // e.g., "WP18 2025" or "WP18 2025" without space; we expect "WP18YYYY"
  const m = /^WP(\d{2})\s?-?\d{4}$/.exec(String(id));
  return m ? Number(m[1]) : null;
};


/* ---------------- cache for IBTrACS ---------------- */
let cache = {
  filePath: IBTRACS_PATH,
  mtimeMs: 0,
  rows: null,
  allMap: null,
  yearMaps: new Map(),
};

function ensureLoaded(force = false) {
  const st = fs.statSync(cache.filePath);
  if (force || !cache.rows || st.mtimeMs !== cache.mtimeMs) {
    const rows = filterWP(loadIBTrACS(cache.filePath));
    cache.rows = rows;
    cache.allMap = groupByStorm(rows);
    cache.yearMaps.clear();
    cache.mtimeMs = st.mtimeMs;
    console.log(`[ibtracs] loaded ${rows.length} rows from ${cache.filePath}`);
  }
}
// Map a reference month/day to the given season year (end-of-day UTC)
function cutoffForYear(refDate, year) {
  if (!refDate) return null;
  const m = refDate.getUTCMonth();
  const d = refDate.getUTCDate();
  return new Date(Date.UTC(Number(year), m, d, 23, 59, 59, 999));
}

function ytdStormExtras(stormMap, year, cutoffRefDate) {
  if (!cutoffRefDate) return { stormsCount: null, maxWind: null, parCount: null };

  const limit = cutoffForYear(new Date(cutoffRefDate), year); // real Date!
  const y = Number(year);

  let stormsCount = 0;
  let maxWind = 0;
  let parCount = 0;

  for (const [, pts] of stormMap) {
    if (y && pts[0]?.season !== y) continue;

    // points up to the *year-mapped* cutoff
    const ptsY = pts.filter(p => p.time && p.time <= limit);
    if (ptsY.length === 0) continue;

    stormsCount++;

    // max 1-min wind (rounded to 5 kt) up to cutoff
    for (const p of ptsY) {
      const w = round5(p.usaWind);
      if (w != null && w > maxWind) maxWind = w;
    }

    // At least one fix inside PAR up to cutoff?
    let enteredPAR = false;
    for (const p of ptsY) {
      if (insidePAR(p.lat, p.lon)) { enteredPAR = true; break; }
    }
    if (enteredPAR) parCount++;
  }

  return { stormsCount, maxWind, parCount };
}



function mapForYear(year) {
  ensureLoaded();
  const y = Number(year);
  if (!cache.yearMaps.has(y)) {
    cache.yearMaps.set(y, groupByStorm(cache.rows, y));
  }
  return cache.yearMaps.get(y);
}

/** Build daily series (Jan1→end) from b-decks */
function dailyFromBDecks(bstorms, endDate){
  const limit = endOfDayUTC(new Date(endDate));
  const year = Number(new Date(endDate).getUTCFullYear());
  const start = Date.UTC(year,0,1);
  const nDays = Math.floor((Date.UTC(year, new Date(endDate).getUTCMonth(), new Date(endDate).getUTCDate()) - start)/MS_PER_DAY) + 1;

  const daily = Array(nDays).fill(0);
  for (const s of bstorms){
    if (isInvest(s.num)) continue;
    for (const p of s.points){
      if (!p.t || p.t > limit) continue;
      if (!isSynoptic(p.t)) continue;
      const w = round5(p.wind);
      if (w != null && w >= 35){
        const di = Math.floor((Date.UTC(p.t.getUTCFullYear(), p.t.getUTCMonth(), p.t.getUTCDate()) - start)/MS_PER_DAY);
        if (di >= 0 && di < nDays) daily[di] += aceFromWindKt(w);
      }
    }
  }
  const labels = [];
  const cum = [];
  let run=0;
  for (let i=0;i<nDays;i++){
    run += daily[i];
    cum.push(Number(run.toFixed(1)));
    const dt = new Date(Date.UTC(year,0,1) + i*MS_PER_DAY);
    labels.push(dt.toISOString().slice(0,10));
    daily[i] = Number(daily[i].toFixed(1));
  }
  return { labels, daily, cum, total: cum[cum.length-1] ?? 0 };
}


// Build YTD ACE totals (to the SAME month/day) for a range of years.
// Returns [{ year, total }] for baseStart..baseEnd inclusive.
function buildBaselineYtdTotals(rows, month, day, baseStart = 1950, baseEnd = 2024) {
  const out = [];
  for (let y = baseStart; y <= baseEnd; y++) {
    const cutoff = new Date(Date.UTC(y, month, day, 23, 59, 59, 999)); // real Date
    const total = computeACEYTD(rows, y, cutoff);
    out.push({ year: y, total });
  }
  return out;
}


/* ---------------- small helpers used for b-decks ---------------- */
const VALID_HOURS = new Set([0, 6, 12, 18]);
const isSynoptic = d => VALID_HOURS.has(d.getUTCHours());
const round5 = w => (w == null ? null : Math.round(Number(w) / 5) * 5);
const aceFromWindKt = v => (v * v) / 10000.0;
const endOfDayUTC = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
const isInvest = n => n >= 90 && n <= 99;

/** Convert b-deck storms into the same shape our metrics expect */
function bdeckToStormMap(bstorms) {
  const map = new Map();
  for (const s of bstorms) {
    if (isInvest(s.num)) continue;
    const pts = s.points.map(p => ({
      season: s.year,
      time: p.t,
      lat: p.lat,
      lon: p.lon,
      usaWind: p.wind,
      usaPres: p.pres,
      name: s.name || '',
    }));
    pts.sort((a, b) => a.time - b.time);
    map.set(s.id, pts);
  }
  return map;
}

/** Monthly ACE from b-decks, honoring an optional cutoff date */
function monthlyAceFromBDecks(bstorms, cutoff) {
  const limit = cutoff ? endOfDayUTC(new Date(cutoff)) : null;
  const monthlyRaw = Array(12).fill(0);
  let totalRaw = 0;

  for (const s of bstorms) {
    if (isInvest(s.num)) continue;
    for (const p of s.points) {
      if (!p.t) continue;
      if (limit && p.t > limit) continue;
      if (!isSynoptic(p.t)) continue;
      const w = round5(p.wind);
      if (w != null && w >= 35) {
        const ace = aceFromWindKt(w);
        monthlyRaw[p.t.getUTCMonth()] += ace;
        totalRaw += ace;
      }
    }
  }

  // one rounding step at the end
  const monthly = monthlyRaw.map(v => Number(v.toFixed(1)));
  const total = Number(totalRaw.toFixed(1));
  return { monthly, total };
}


/** ACE YTD & cumulative from b-decks up to cutoff */
function aceYTDFromBDecks(bstorms, cutoffDate) {
  const limit = endOfDayUTC(new Date(cutoffDate));
  const monthly = Array(12).fill(0);
  let total = 0;
  for (const s of bstorms) {
    if (isInvest(s.num)) continue;
    for (const p of s.points) {
      if (!p.t || p.t > limit) continue;
      if (!isSynoptic(p.t)) continue;
      const w = round5(p.wind);
      if (w != null && w >= 35) {
        const ace = aceFromWindKt(w);
        monthly[p.t.getUTCMonth()] += ace;
        total += ace;
      }
    }
  }
  const cum = [];
  let run = 0;
  for (let i = 0; i < 12; i++) { run += monthly[i]; cum.push(Number(run.toFixed(1))); }
  return { total: Number(total.toFixed(1)), cum };
}

/* ---------------- health & reload ---------------- */
router.get('/health', (_req, res) => {
  res.json({ ok: true, ibtracs: cache.rows ? 'loaded' : 'unloaded', path: cache.filePath });
});

router.get('/current/working', async (req, res) => {
  const year = Number(req.query.year || DEFAULT_YEAR);
  const max = Math.min(Math.max(Number(req.query.max || 60), 1), 99);
  try {
    const storms = (await fetchActiveWorkingStorms(year, max))
      .filter(s => !isInvest(s.num))
      .map(s => {
        let ace = 0;
        for (const p of s.points) {
          if (!p.t) continue;
          const hr = p.t.getUTCHours();
          if (hr !== 0 && hr !== 6 && hr !== 12 && hr !== 18) continue;
          const w = round5(p.wind);
          if (w >= 35) ace += (w * w) / 10000.0;
        }
        return { id: s.id, num: s.num, year: s.year, ace: Number(ace.toFixed(1)), points: s.points };
      });

    res.json({ year, storms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.get('/reload', (_req, res) => {
  try { ensureLoaded(true); res.json({ ok: true, reloaded: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ----------------------- YTD RANKS (neighbors) ----------------------------
// GET /api/ranks?year=2025&cutoff=2025-08-21&base_start=1950&base_end=2024
// GET /api/ranks?year=2025&cutoff=2025-09-07&base_start=1950&base_end=2024&span=all
router.get('/ranks', async (req, res) => {
  try {
    ensureLoaded();

    const year       = Number(req.query.year || DEFAULT_YEAR);
    const cutoffStr  = String(req.query.cutoff || new Date().toISOString().slice(0,10));
    const cutoffDate = new Date(cutoffStr);

    const baseStart  = Number(req.query.base_start || 1950);
    const baseEnd    = Number(req.query.base_end   || 2024);

    // span can be "all" or an integer (default 9 → 4 above, current, 4 below)
    const spanParam  = String(req.query.span || '9');
    const wantAll    = (spanParam.toLowerCase() === 'all');
    const span       = wantAll ? null : Math.max(1, parseInt(spanParam, 10) || 9);

    // ---- Build baseline list (IBTrACS only) for the same month/day across years
    const month = cutoffDate.getUTCMonth();
    const day   = cutoffDate.getUTCDate();
    const baseline = buildBaselineYtdTotals(cache.rows, month, day, baseStart, baseEnd);
    baseline.sort((a, b) => b.total - a.total);             // highest ACE first

    // ---- Compute the selected year's YTD total (b-decks for 2025+, IBTrACS <=2024)
    let currentTotal = null;
    if (year >= 2025) {
      const wstorms = (await fetchActiveWorkingStorms(year, 60)).filter(s => !isInvest(s.num));
      const { total } = aceYTDFromBDecks(wstorms, cutoffDate);
      currentTotal = Number(total.toFixed(1));
    } else {
      currentTotal = Number(computeACEYTD(cache.rows, year, cutoffDate).toFixed(1));
    }

    // ---- Check whether selected year is part of the baseline range
    const inBaseline = (year >= baseStart && year <= baseEnd);

    // These will be filled below
    let population;      // number of rows in the ranked list
    let currentRank;     // rank of the selected/current year (1 = highest)
    let listForOutput;   // full ordered list with rank numbers (augmented if needed)

    if (inBaseline) {
      // Rank is the index of the matching baseline row + 1
      const idx = baseline.findIndex(e => e.year === year);
      currentRank = (idx >= 0) ? (idx + 1) : null;         // should exist
      population  = baseline.length;

      // Full list (for "all") or we’ll slice a window below
      listForOutput = baseline.map((e, i) => ({
        year: e.year,
        total: Number(e.total.toFixed(1)),
        rank: i + 1,
        isCurrent: e.year === year
      }));

    } else {
      // Insert synthetic "current" into the sorted baseline
      let insertIdx = baseline.findIndex(e => e.total <= currentTotal);
      if (insertIdx === -1) insertIdx = baseline.length; // it's the lowest

      const augmented = [
        ...baseline.slice(0, insertIdx),
        { year, total: currentTotal, isCurrent: true },
        ...baseline.slice(insertIdx)
      ];

      population  = augmented.length;        // baseline + 1
      currentRank = insertIdx + 1;

      listForOutput = augmented.map((e, i) => ({
        year: e.year,
        total: Number(e.total.toFixed(1)),
        rank: i + 1,
        isCurrent: !!e.isCurrent
      }));
    }

    // Add delta (difference vs current) to each row
    listForOutput = listForOutput.map(row => ({
      ...row,
      delta: Number((row.total - currentTotal).toFixed(1))
    }));

    // Prepare "window" according to span
    let window;
    if (wantAll) {
      window = listForOutput;
    } else {
      // find current index to center the window
      const curIdx = listForOutput.findIndex(r => r.year === year);
      const start  = Math.max(0, curIdx - Math.floor(span / 2));
      const end    = Math.min(listForOutput.length, start + span);
      window       = listForOutput.slice(start, end);
    }

    res.json({
      year,
      asOf: cutoffStr,
      baseline: { start: baseStart, end: baseEnd, years: baseline.length },
      population,                                        // includes current if not in baseline
      current: { year, total: currentTotal, rank: currentRank },
      window                                              // array of {year,total,rank,isCurrent,delta}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



/* ---------------- summary ---------------- */
/* ---------------- summary ---------------- */
router.get('/summary', async (req, res) => {
  const year      = Number(req.query.year || DEFAULT_YEAR);
  const baseStart = Number(req.query.base_start || 1950);
  const baseEnd   = Number(req.query.base_end   || 2024);
  // cutoff is a Date (or null). Metrics functions will map its month/day into each year.
  const cutoff    = req.query.cutoff ? new Date(String(req.query.cutoff)) : null;

  try {
    ensureLoaded();

    // --- Baseline category-days average (honors cutoff month/day if provided)
    const sums = { TD: 0, TS: 0, STS: 0, TY: 0, STY: 0 };
    let yearsUsed = 0;
    for (let y = baseStart; y <= baseEnd; y++) {
      const m = groupByStorm(cache.rows, y);
      if (!m.size) continue;
      const d = computeCategoryDays(m, y, cutoff); // function rebases cutoff to that y
      sums.TD  += d.TD;  sums.TS  += d.TS;  sums.STS += d.STS;  sums.TY += d.TY;  sums.STY += d.STY;
      yearsUsed++;
    }
    const catAvg = {
      TD:  Number((sums.TD  / yearsUsed).toFixed(1)),
      TS:  Number((sums.TS  / yearsUsed).toFixed(1)),
      STS: Number((sums.STS / yearsUsed).toFixed(1)),
      TY:  Number((sums.TY  / yearsUsed).toFixed(1)),
      STY: Number((sums.STY / yearsUsed).toFixed(1)),
    };

    // === 2025+ (UCAR b-decks) ============================================
    if (year >= 2025) {
      const wstorms  = (await fetchActiveWorkingStorms(year, 60)).filter(s => !isInvest(s.num));
      const stormMap = bdeckToStormMap(wstorms);
      const { monthly, total } = monthlyAceFromBDecks(wstorms, cutoff);
      const storms  = computeStormSummaries(stormMap, year);
      const catDays = computeCategoryDays(stormMap, year, cutoff);
      const par     = computePARMonthlyEntries(stormMap, year);
      const formed  = computeStormsFormedByMonth(stormMap, year);

      // YTD-only extras (up to the same month/day)
      const ytd = cutoff ? ytdStormExtras(stormMap, year, cutoff) : null;

      return res.json({
        year,
        asOf: new Date().toISOString(),
        ace: { total, monthly },
        categoryDays: catDays,
        categoryDaysClimo: { average: catAvg, baseline: { start: baseStart, end: baseEnd, years: yearsUsed } },
        par,
        stormsByMonth: formed,
        storms,
        ytd
      });
    }

    // === ≤ 2024 (IBTrACS) ================================================
    const stormMap  = mapForYear(year);
    const monthly   = computeACEByMonth(cache.rows, year, cutoff);
    const storms    = computeStormSummaries(stormMap, year);
    const catDays   = computeCategoryDays(stormMap, year, cutoff);
    const par       = computePARMonthlyEntries(stormMap, year);
    const formed    = computeStormsFormedByMonth(stormMap, year);
    const totalAce  = Number(monthly.reduce((a, b) => a + b, 0).toFixed(1));

    const ytd = cutoff ? ytdStormExtras(stormMap, year, cutoff) : null;

    return res.json({
      year,
      asOf: new Date().toISOString(),
      ace: { total: totalAce, monthly },
      categoryDays: catDays,
      categoryDaysClimo: { average: catAvg, baseline: { start: baseStart, end: baseEnd, years: yearsUsed } },
      par,
      stormsByMonth: formed,
      storms,
      ytd
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* ---------------- ACE by cutoff (YTD) ---------------- */
router.get('/ace/cutoff', async (req, res) => {
  try {
    ensureLoaded();
    const year = Number(req.query.year || DEFAULT_YEAR);
    const cutoffStr = String(req.query.cutoff || new Date().toISOString().slice(0,10));
    const cutoff = new Date(cutoffStr);  // real Date
    const baseStart = Number(req.query.base_start || 1950);
    const baseEnd   = Number(req.query.base_end   || 2024);

    // 1950–2024 average stays from IBTrACS
    const { average, avgCumMonthly, yearsUsed } =
      computeACEYTDClimo(cache.rows, cutoff.getUTCMonth(), cutoff.getUTCDate(), baseStart, baseEnd);

    if (year >= 2025) {
      const wstorms = (await fetchActiveWorkingStorms(year, 60)).filter(s => !isInvest(s.num));
      const { total, cum } = aceYTDFromBDecks(wstorms, cutoff);
      const pct = average > 0 ? Number(((total / average) * 100).toFixed(0)) : null;

      return res.json({
        year,
        asOf: cutoff.toISOString().slice(0, 10),
        cutoffUTC: endOfDayUTC(cutoff).toISOString(),
        baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
        current: total,
        average,
        pctOfAverage: pct,
        monthly: { currentCum: cum, averageCum: avgCumMonthly },
      });
    }

    // <= 2024: IBTrACS
    const current = computeACEYTD(cache.rows, year, cutoff);
    const currentCum = computeACEYTDMonthlyCum(cache.rows, year, cutoff);
    const pct = average > 0 ? Number(((current / average) * 100).toFixed(0)) : null;

    res.json({
      year,
      asOf: cutoff.toISOString().slice(0, 10),
      cutoffUTC: endOfDayUTC(cutoff).toISOString(),
      baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
      current,
      average,
      pctOfAverage: pct,
      monthly: { currentCum, averageCum: avgCumMonthly },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ----------------------- DAILY ACE (Jan1 → end date) ---------------------
router.get('/ace/daily', async (req, res) => {
  try{
    ensureLoaded();
    const year = Number(req.query.year || DEFAULT_YEAR);
    const endStr = String(req.query.end || new Date().toISOString().slice(0,10));
    const endDate = new Date(endStr);
    const baseStart = Number(req.query.base_start || 1950);
    const baseEnd   = Number(req.query.base_end   || 2024);

    // Baseline (always IBTrACS)
    const {
      avgDaily, avgCum, minCum, maxCum,
      sd05Low, sd05High, sd1Low, sd1High,
      baselineTotals, yearsUsed
    } = computeACEDailyClimo(cache.rows, endDate.getUTCMonth(), endDate.getUTCDate(), baseStart, baseEnd);

    if (year >= 2025){
      const wstorms = (await fetchActiveWorkingStorms(year, 60)).filter(s => !isInvest(s.num));
      const current = dailyFromBDecks(wstorms, endDate);

      // rank vs baseline (1 = highest)
      const higher = baselineTotals.filter(t => t > current.total).length;
      const rankHigh = higher + 1;

      return res.json({
        year, asOf: endStr,
        baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
        labels: current.labels,
        current: { daily: current.daily, cum: current.cum, total: current.total },
        average: { daily: avgDaily, cum: avgCum },
        bands: {
          range: { low: minCum, high: maxCum },
          sd1:   { low: sd1Low,  high: sd1High },
          sd05:  { low: sd05Low, high: sd05High }
        },
        rank: { high: rankHigh, of: yearsUsed }
      });
    }

    // <= 2024: IBTrACS
    const current = computeACEDaily(cache.rows, year, endDate);
    const higher = baselineTotals.filter(t => t > current.total).length;
    const rankHigh = higher + 1;

    res.json({
      year, asOf: endStr,
      baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
      labels: current.labels,
      current: { daily: current.daily, cum: current.cum, total: current.total },
      average: { daily: avgDaily, cum: avgCum },
      bands: {
        range: { low: minCum, high: maxCum },
        sd1:   { low: sd1Low,  high: sd1High },
        sd05:  { low: sd05Low, high: sd05High }
      },
      rank: { high: rankHigh, of: yearsUsed }
    });
  }catch(err){
    res.status(500).json({ error: err.message });
  }
});


/* ---------------- storms list ---------------- */
router.get('/storms', async (req, res) => {
  const year = Number(req.query.year || DEFAULT_YEAR);
  try {
    if (year >= 2025) {
      const wstorms = (await fetchActiveWorkingStorms(year, 60)).filter(s => !isInvest(s.num));
      const stormMap = bdeckToStormMap(wstorms);
      const storms = computeStormSummaries(stormMap, year);
      return res.json({ year, count: storms.length, storms });
    }
    const stormMap = mapForYear(year);
    const storms = computeStormSummaries(stormMap, year);
    res.json({ year, count: storms.length, storms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- individual track ---------------- */
router.get('/storms/:id/track', async (req, res) => {
  const year = Number(req.query.year || DEFAULT_YEAR);
  const id = req.params.id;
  try {
    if (year >= 2025) {
      // Try direct fetch by number (CARQ→TCVITALS→b-deck)
      const n = numFromId(id);
      if (n != null) {
        try {
          const s = await fetchWorkingStorm(year, n);
          if (s && s.points && s.points.length) {
            const out = s.points.map(p => ({ t: p.t, lat: p.lat, lon: p.lon, wind: p.wind, pres: p.pres }));
            return res.json({ id: s.id, year: s.year, points: out });
          }
        } catch { /* ignore and fall back */ }
      }
      // Fallback: scan actives and find id
      const wstorms = await fetchActiveWorkingStorms(year, 60);
      const s = wstorms.find(x => x.id === id);
      if (s) {
        const out = s.points.map(p => ({ t: p.t, lat: p.lat, lon: p.lon, wind: p.wind, pres: p.pres }));
        return res.json({ id, year, points: out });
      }
    }

    // fallback: IBTrACS
    ensureLoaded();
    const pts = cache.allMap.get(id) || [];
    const filtered = year ? pts.filter(p => p.season === year) : pts;
    const out = filtered.map(p => ({ t: p.time, lat: p.lat, lon: p.lon, wind: p.usaWind, pres: p.usaPres }));
    res.json({ id, year, points: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* ---------------- current b-decks (unchanged) ---------------- */
router.get('/current/bdecks', async (req, res) => {
  const year = Number(req.query.year || DEFAULT_YEAR);
  const max = Math.min(Math.max(Number(req.query.max || 60), 1), 99);
  try {
    const data = await fetchActiveBDecks(year, max);
    const storms = data
      .filter(s => !isInvest(s.num))
      .map(s => {
        let ace = 0;
        for (const p of s.points) {
          if (!p.t) continue;
          const hr = p.t.getUTCHours();
          if (hr !== 0 && hr !== 6 && hr !== 12 && hr !== 18) continue;
          const w = round5(p.wind);
          if (w >= 35) ace += (w * w) / 10000.0;
        }
        return { id: s.id, num: s.num, year: s.year, ace: Number(ace.toFixed(1)), points: s.points };
      });
    res.json({ year, storms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
