// ---------- CONFIG ----------
const API_BASE = 'https://extension-47r9.onrender.com'; // change to '' or '/api' if same origin

// ---------- HELPERS ----------
function fmt(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function ymd(d){ const dt = new Date(d); return isNaN(dt) ? '' : dt.toISOString().slice(0,10); }
function defaultCutoffForYear(y){
  const nowY = new Date().getUTCFullYear();
  return (y < nowY) ? `${y}-12-31` : new Date().toISOString().slice(0,10);
}
function el(id){ return document.getElementById(id); }

// ---------- API ----------
async function fetchRanks(year, cutoff){
  const u = new URL('/api/ranks', API_BASE);
  u.searchParams.set('year', year);
  u.searchParams.set('cutoff', cutoff);
  u.searchParams.set('base_start', 1950);
  u.searchParams.set('base_end', 2024);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error('ranks failed');
  return res.json();
}

async function fetchSummary(year, cutoff){
  const u = new URL('/api/summary', API_BASE);
  u.searchParams.set('year', year);
  u.searchParams.set('cutoff', cutoff);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error('summary failed for '+year);
  return res.json();
}

// ---------- UI BUILD ----------
function buildYearSelect(){
  const sel = el('yearSelect');
  const nowY = new Date().getUTCFullYear();
  for (let y = nowY; y >= 1950; y--){
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  }
  sel.value = nowY;
  el('cutoffDate').value = defaultCutoffForYear(nowY);

  sel.addEventListener('change', () => {
    const y = Number(sel.value);
    el('cutoffDate').value = defaultCutoffForYear(y);
  });
}

function renderStatus(msg){ el('status').textContent = msg; }

function renderTop(summary, ranks){
  el('asOf').textContent = 'As of ' + ranks.asOf;
  el('currentAce').textContent = fmt(ranks.current.total);
  el('currentRank').textContent = ranks.current.rank;
  el('rankOf').textContent = `of ${ranks.baseline.years}`;
}

function makeRowHTML(row, extra) {
  const diff = (extra && extra._diff) || 0;
  const diffClass = diff === 0 ? '' : (diff > 0 ? 'bad' : 'good');
  const diffText = diff === 0 ? '—' : (diff > 0 ? `+${fmt(diff)}` : `${fmt(diff)}`);

  // extra fields (from /summary)
  const storms = extra ? (extra.storms?.length ?? '—') : '—';
  const maxW   = extra ? (extra.storms?.reduce((m,s)=>Math.max(m, s.maxWind||0),0) ?? 0) : 0;
  const minP   = extra ? (extra.storms?.reduce((m,s)=> (s.minPres && s.minPres>0) ? Math.min(m, s.minPres) : m, Infinity) || null) : null;
  const parTot = extra ? (extra.par?.total ?? '—') : '—';

  const maxWtxt = maxW ? `${Math.round(maxW/5)*5} kt` : '—';
  const minPtxt = Number.isFinite(minP) ? `${minP} hPa` : '—';

  return `<tr>
    <td class="rank">${row.rank}</td>
    <td class="year-cell">${row.year}</td>
    <td>${fmt(row.total)}</td>
    <td class="diff ${diffClass}">${diffText}</td>
    <td>${storms}</td>
    <td>${maxWtxt}</td>
    <td>${minPtxt}</td>
    <td>${parTot}</td>
  </tr>`;
}

async function renderTable(ranks){
  const tableWrap = el('ranksTable');
  tableWrap.innerHTML = '';

  // fetch extra summary for each year in the window (parallel)
  const cutoff = ranks.asOf;
  const years  = ranks.window.map(r => r.year);

  const summaries = await Promise.allSettled(
    years.map(y => fetchSummary(y, cutoff))
  );

  // index extras by year
  const extraByYear = new Map();
  summaries.forEach((p,i) => {
    if (p.status === 'fulfilled') {
      extraByYear.set(years[i], p.value);
    }
  });

  // compute current for diff
  const current = ranks.current.total;

  const tbl = document.createElement('table');
  tbl.innerHTML = `<thead>
    <tr>
      <th>Rank</th>
      <th>Year</th>
      <th>YTD ACE</th>
      <th>Δ vs current</th>
      <th>Storms*</th>
      <th>Max 1-min</th>
      <th>Min CP</th>
      <th>PAR entries</th>
    </tr>
  </thead><tbody></tbody>`;
  const tbody = tbl.querySelector('tbody');

  ranks.window.forEach(row => {
    const extra = extraByYear.get(row.year);
    if (extra) extra._diff = Number((row.total - current).toFixed(1));
    const tr = document.createElement('tr');
    tr.innerHTML = makeRowHTML(row, extra);
    tbody.appendChild(tr);
  });

  tableWrap.appendChild(tbl);
}

async function refresh(){
  const year   = Number(el('yearSelect').value);
  const cutoff = el('cutoffDate').value;

  try{
    renderStatus('Loading …');
    const ranks = await fetchRanks(year, cutoff);
    renderTop(null, ranks);
    await renderTable(ranks);
    renderStatus('Loaded.');
  }catch(e){
    console.error(e);
    renderStatus('Failed: ' + e.message);
  }
}

// ---------- BOOT ----------
(function init(){
  buildYearSelect();
  el('refreshBtn').addEventListener('click', refresh);
  refresh();
})();
