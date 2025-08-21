// backend/src/routes/api.js
import express from 'express';
import fs from 'fs';

import { IBTRACS_PATH, DEFAULT_YEAR } from '../config.js';
import { loadIBTrACS, filterWP, groupByStorm } from '../parsers/ibtracs.js';
import { fetchActiveBDecks } from '../parsers/bdeck.js';
import {
  computeACEByMonth, computeStormSummaries,
  computeCategoryDays, computePARMonthlyEntries, computeStormsFormedByMonth,
  computeACEYTD, computeACEYTDMonthlyCum, computeACEYTDClimo,
  computeACEDaily, computeACEDailyClimo               // <-- add these
} from '../services/metrics.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const router = express.Router();

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

router.get('/reload', (_req, res) => {
  try { ensureLoaded(true); res.json({ ok: true, reloaded: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- summary ---------------- */
router.get('/summary', async (req, res) => {
  const year = Number(req.query.year || DEFAULT_YEAR);
  const baseStart = Number(req.query.base_start || 1950);
  const baseEnd = Number(req.query.base_end || 2024);
  const cutoff = req.query.cutoff ? new Date(req.query.cutoff) : null;

  try {
    // Always have climatology for the comparison
    ensureLoaded();
    const sums = { TD:0, TS:0, STS:0, TY:0, STY:0 };
    let yearsUsed = 0;
    for (let y = baseStart; y <= baseEnd; y++) {
      const m = groupByStorm(cache.rows, y);
      if (!m.size) continue;
      const d = computeCategoryDays(m, y);
      sums.TD += d.TD; sums.TS += d.TS; sums.STS += d.STS; sums.TY += d.TY; sums.STY += d.STY;
      yearsUsed++;
    }
    const catAvg = {
      TD: Number((sums.TD / yearsUsed).toFixed(1)),
      TS: Number((sums.TS / yearsUsed).toFixed(1)),
      STS: Number((sums.STS / yearsUsed).toFixed(1)),
      TY: Number((sums.TY / yearsUsed).toFixed(1)),
      STY: Number((sums.STY / yearsUsed).toFixed(1)),
    };

    // For 2025+ use UCAR b-decks
    if (year >= 2025) {
  const bstorms = (await fetchActiveBDecks(year, 60)).filter(s => !isInvest(s.num));

  // convert to our “stormMap” shape once, for downstream metrics
  const stormMap = bdeckToStormMap(bstorms);

  // get both monthly + total from the same accumulation (one final rounding)
  const { monthly, total } = monthlyAceFromBDecks(bstorms, cutoff);

  const storms  = computeStormSummaries(stormMap, year);
  const catDays = computeCategoryDays(stormMap, year, cutoff || null);
  const par     = computePARMonthlyEntries(stormMap, year);
  const formed  = computeStormsFormedByMonth(stormMap, year);

  return res.json({
    year,
    asOf: new Date().toISOString(),
    ace: { total, monthly },
    categoryDays: catDays,
    categoryDaysClimo: { average: catAvg, baseline: { start: baseStart, end: baseEnd, years: yearsUsed } },
    par,
    stormsByMonth: formed,
    storms,
  });
}

    // <= 2024: IBTrACS
    const stormMap = mapForYear(year);
    const monthlyAce = computeACEByMonth(cache.rows, year, cutoff);
    const storms = computeStormSummaries(stormMap, year);
    const catDays = computeCategoryDays(stormMap, year, cutoff || null);
    const par = computePARMonthlyEntries(stormMap, year);
    const formed = computeStormsFormedByMonth(stormMap, year);
    const totalAce = Number(monthlyAce.reduce((a, b) => a + b, 0).toFixed(1));

    res.json({
      year,
      asOf: new Date().toISOString(),
      ace: { total: totalAce, monthly: monthlyAce },
      categoryDays: catDays,
      categoryDaysClimo: { average: catAvg, baseline: { start: baseStart, end: baseEnd, years: yearsUsed } },
      par,
      stormsByMonth: formed,
      storms,
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
    const cutoff = req.query.cutoff ? new Date(req.query.cutoff) : new Date();
    const baseStart = Number(req.query.base_start || 1950);
    const baseEnd = Number(req.query.base_end || 2024);

    // 1950–2024 average stays from IBTrACS
    const { average, avgCumMonthly, yearsUsed } =
      computeACEYTDClimo(cache.rows, cutoff.getUTCMonth(), cutoff.getUTCDate(), baseStart, baseEnd);

    if (year >= 2025) {
      const bstorms = (await fetchActiveBDecks(year, 60)).filter(s => !isInvest(s.num));
      const { total, cum } = aceYTDFromBDecks(bstorms, cutoff);
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

    // Daily climatology always from IBTrACS
    const { avgDaily, avgCum, yearsUsed } =
      computeACEDailyClimo(cache.rows, endDate.getUTCMonth(), endDate.getUTCDate(), baseStart, baseEnd);

    if (year >= 2025){
      const bstorms = (await fetchActiveBDecks(year, 60)).filter(s => !isInvest(s.num));
      const current = dailyFromBDecks(bstorms, endDate);
      return res.json({
        year, asOf: endStr,
        baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
        labels: current.labels,                 // YYYY-MM-DD for the chosen year
        current: { daily: current.daily, cum: current.cum, total: current.total },
        average: { daily: avgDaily, cum: avgCum } // "MM-DD" axis length matches labels
      });
    }

    // <=2024: IBTrACS
    const current = computeACEDaily(cache.rows, year, endDate);
    res.json({
      year, asOf: endStr,
      baseline: { start: baseStart, end: baseEnd, years: yearsUsed },
      labels: current.labels,
      current: { daily: current.daily, cum: current.cum, total: current.total },
      average: { daily: avgDaily, cum: avgCum }
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
      const bstorms = (await fetchActiveBDecks(year, 60)).filter(s => !isInvest(s.num));
      const stormMap = bdeckToStormMap(bstorms);
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
      const bstorms = await fetchActiveBDecks(year, 60);
      const s = bstorms.find(x => x.id === id);
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
