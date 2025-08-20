// backend/src/services/metrics.js

// --- ACE + time helpers --------------------------------------------------
const ACE_THRESHOLD = 35;
const VALID_HOURS = new Set([0, 6, 12, 18]);
const isSynopticHour = (d) => VALID_HOURS.has(d.getUTCHours());
const endOfDayUTC = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
const round5 = (w) => (w == null ? null : Math.round(Number(w) / 5) * 5);
function aceFromWindKt(v) { return (v * v) / 10000.0; }

// --- PAR polygon (x=lon, y=lat), boundary inclusive ---------------------
const PAR_POLY = [
  [115, 5],  [115, 15], [120, 21],
  [120, 25], [135, 25], [135, 5]
];

function pointOnSegment(x, y, x1, y1, x2, y2, eps = 1e-9) {
  const cross = (y - y1) * (x2 - x1) - (x - x1) * (y2 - y1);
  if (Math.abs(cross) > eps) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < -eps) return false;
  const lenSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (dot - lenSq > eps) return false;
  return true;
}

export function insidePAR(lat, lon) {
  if (lat == null || lon == null) return false;
  const x = lon, y = lat;

  // boundary-inclusive
  for (let i = 0, j = PAR_POLY.length - 1; i < PAR_POLY.length; j = i++) {
    const [xi, yi] = PAR_POLY[i], [xj, yj] = PAR_POLY[j];
    if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;
  }

  // ray casting
  let inside = false;
  for (let i = 0, j = PAR_POLY.length - 1; i < PAR_POLY.length; j = i++) {
    const [xi, yi] = PAR_POLY[i], [xj, yj] = PAR_POLY[j];
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// --- Monthly ACE (synoptic hours only; winds rounded to 5 kt) -----------
export function computeACEByMonth(rows, year, cutoff = null) {
  const monthly = Array(12).fill(0);
  const limit = cutoff ? endOfDayUTC(cutoff) : null;

  for (const r of rows) {
    if (year && r.season !== Number(year)) continue;
    if (limit && r.time > limit) continue;
    if (!isSynopticHour(r.time)) continue;

    const w = round5(r.usaWind);
    if (w != null && w >= ACE_THRESHOLD) {
      monthly[r.time.getUTCMonth()] += aceFromWindKt(w);
    }
  }

  return monthly.map(v => Number(v.toFixed(1)));
}

export function computeACEByStorm(stormPoints) {
  let s = 0;
  for (const p of stormPoints) {
    if (!isSynopticHour(p.time)) continue;
    const w = round5(p.usaWind);
    if (w != null && w >= ACE_THRESHOLD) s += aceFromWindKt(w);
  }
  return Number(s.toFixed(1));
}

// --- Storm summaries (with PAR first entry) ------------------------------
export function computeStormSummaries(stormMap, year) {
  const out = [];
  for (const [id, pts] of stormMap) {
    if (year && pts[0]?.season !== Number(year)) continue;

    const name  = pts[0]?.name || '';
    const start = pts[0]?.time;
    const end   = pts[pts.length - 1]?.time;

    let maxWind = 0, minPres = null, ace = 0, parInDate = null;

    for (const p of pts) {
      const w = round5(p.usaWind ?? 0);               // nearest 5 kt
      if (w > maxWind) maxWind = w;

      const pr = p.usaPres;
      if (Number.isFinite(pr) && pr > 0) {
        minPres = (minPres == null) ? pr : Math.min(minPres, pr);
      }

      if (isSynopticHour(p.time) && w >= ACE_THRESHOLD) {
        ace += aceFromWindKt(w);
      }

      if (!parInDate && insidePAR(p.lat, p.lon)) parInDate = p.time;
    }

    out.push({
      id, name, start, end,
      maxWind, minPres,
      ace: Number(ace.toFixed(1)),
      parInDate
    });
  }

  out.sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0));
  return out;
}

// --- Category days (hours capped; optional cutoff within season year) ---
function classify1min(w) {
  if (w == null) return 'UNK';
  if (w < 34) return 'TD';
  if (w < 48) return 'TS';
  if (w < 64) return 'STS';
  if (w < 130) return 'TY';
  return 'STY';
}

/**
 * cutoffRefDate: a Date whose month/day are used as the cutoff within `year`.
 * If null, counts the whole season.
 */
export function computeCategoryDays(stormMap, year, cutoffRefDate = null) {
  const hours = { TD: 0, TS: 0, STS: 0, TY: 0, STY: 0 };

  const limit = cutoffRefDate
    ? new Date(Date.UTC(
        Number(year),
        cutoffRefDate.getUTCMonth(),
        cutoffRefDate.getUTCDate(),
        23, 59, 59, 999
      ))
    : null;

  for (const [, pts] of stormMap) {
    if (year && pts[0]?.season !== Number(year)) continue;

    for (let i = 0; i < pts.length; i++) {
      const cur  = pts[i];
      const next = pts[i + 1];

      // default interval: to next fix; if last point, assume +6 h
      let start = cur.time;
      let end   = next ? next.time : new Date(start.getTime() + 6 * 3600 * 1000);

      // apply cutoff trimming
      if (limit) {
        if (start > limit) continue;     // entirely beyond cutoff
        if (end > limit) end = limit;    // trim to cutoff EOD
      }

      let dtHrs = (end - start) / 36e5;
      if (!Number.isFinite(dtHrs) || dtHrs <= 0) continue;
      if (dtHrs > 12) dtHrs = 12;        // safety against bad gaps

      const k = classify1min(cur.usaWind);
      if (hours[k] != null) hours[k] += dtHrs;
    }
  }

  return {
    TD:  Number((hours.TD  / 24).toFixed(1)),
    TS:  Number((hours.TS  / 24).toFixed(1)),
    STS: Number((hours.STS / 24).toFixed(1)),
    TY:  Number((hours.TY  / 24).toFixed(1)),
    STY: Number((hours.STY / 24).toFixed(1)),
  };
}

// --- PAR monthly entries & formed-by-month -------------------------------
export function computePARMonthlyEntries(stormMap, year) {
  const counts = Array(12).fill(0);
  let total = 0;

  for (const [, pts] of stormMap) {
    if (year && pts[0]?.season !== Number(year)) continue;
    let firstIn = null;
    for (const p of pts) {
      if (insidePAR(p.lat, p.lon)) { firstIn = p.time; break; }
    }
    if (firstIn) { counts[firstIn.getUTCMonth()] += 1; total += 1; }
  }

  return { monthly: counts, total };
}

export function computeStormsFormedByMonth(stormMap, year) {
  const counts = Array(12).fill(0);
  for (const [, pts] of stormMap) {
    if (year && pts[0]?.season !== Number(year)) continue;
    const m = pts[0]?.time?.getUTCMonth();
    if (m != null) counts[m] += 1;
  }
  return counts;
}

// --- YTD / cutoff & climatology (synoptic hours; winds rounded) ----------
export function computeACEYTD(rows, year, asOfDate) {
  const cutoff = endOfDayUTC(asOfDate);
  let total = 0;

  for (const r of rows) {
    if (r.season !== Number(year)) continue;
    if (!r.time || r.time > cutoff) continue;
    if (!isSynopticHour(r.time)) continue;

    const w = round5(r.usaWind);
    if (w != null && w >= ACE_THRESHOLD) total += aceFromWindKt(w);
  }

  return Number(total.toFixed(1));
}

export function computeACEYTDMonthlyCum(rows, year, asOfDate) {
  const cutoff = endOfDayUTC(asOfDate);
  const monthly = Array(12).fill(0);

  for (const r of rows) {
    if (r.season !== Number(year)) continue;
    if (!r.time || r.time > cutoff) continue;
    if (!isSynopticHour(r.time)) continue;

    const w = round5(r.usaWind);
    if (w != null && w >= ACE_THRESHOLD) {
      monthly[r.time.getUTCMonth()] += aceFromWindKt(w);
    }
  }

  const cum = [];
  let running = 0;
  for (let i = 0; i < 12; i++) {
    running += monthly[i];
    cum.push(Number(running.toFixed(1)));
  }
  return cum;
}

/** Generic “ACE by cutoff date” alias (same as YTD) */
export function computeACEByCutoff(rows, year, cutoffDate) {
  return {
    total: computeACEYTD(rows, year, cutoffDate),
    cumMonthly: computeACEYTDMonthlyCum(rows, year, cutoffDate),
  };
}

/**
 * Climatology for YTD/cutoff ACE (avg over years), also returning the
 * average cumulative-by-month curve up to the same cutoff (month/day).
 */
export function computeACEYTDClimo(rows, month, day, startYear = 1950, endYear = 2024) {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.season;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }

  let yearsUsed = 0, totalSum = 0;
  const sumCumMonthly = Array(12).fill(0);

  for (let y = startYear; y <= endYear; y++) {
    const list = byYear.get(y) || [];
    const perMonth = Array(12).fill(0);
    const cutoff = endOfDayUTC(new Date(Date.UTC(y, month, day)));

    for (const r of list) {
      if (!r.time || r.time > cutoff) continue;
      if (!isSynopticHour(r.time)) continue;

      const w = round5(r.usaWind);
      if (w != null && w >= ACE_THRESHOLD) {
        perMonth[r.time.getUTCMonth()] += aceFromWindKt(w);
      }
    }

    yearsUsed += 1;

    let run = 0;
    for (let i = 0; i < 12; i++) {
      run += perMonth[i];
      sumCumMonthly[i] += run;
    }
    totalSum += run;
  }

  const average = Number((totalSum / yearsUsed).toFixed(1));
  const avgCumMonthly = sumCumMonthly.map(v => Number((v / yearsUsed).toFixed(1)));
  return { average, avgCumMonthly, yearsUsed, startYear, endYear };
}
