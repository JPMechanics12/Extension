// ---------- CONFIG ----------
const API_BASE =
  location.hostname.includes('localhost')
    ? 'http://localhost:4001'
    : 'https://extension-47r9.onrender.com';

// ---------- HELPERS ----------
function fmt(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function defaultCutoffForYear(y){
  const nowY = new Date().getUTCFullYear();
  return (y < nowY) ? `${y}-12-31` : new Date().toISOString().slice(0,10);
}
const el = id => document.getElementById(id);

// ---------- API ----------
// ---------- API ----------
async function fetchRanks(year, cutoff){
  const u = new URL('/api/ranks', API_BASE);
  u.searchParams.set('year', year);
  u.searchParams.set('cutoff', cutoff);
  u.searchParams.set('base_start', 1950);
  u.searchParams.set('base_end', 2024);
  u.searchParams.set('span', 'all');         // get the full list so we can center on current
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error('ranks failed');
  return res.json();
}
async function fetchSummary(year, cutoff){
  const u = new URL('/api/summary', API_BASE);
  u.searchParams.set('year', year);
  u.searchParams.set('cutoff', cutoff);      // tells server to compute YTD-only extras
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

function renderTop(ranks){
  el('asOf').textContent = 'As of ' + ranks.asOf;
  el('currentAce').textContent = fmt(ranks.current.total);
  el('currentRank').textContent = ranks.current.rank;
  el('rankOf').textContent = `of ${ranks.population || ranks.baseline.years}`;
}


function makeRowHTML(row, extra, currentTotal) {
  const ct = Number(currentTotal);
  const diff = Number.isFinite(ct) ? Number((row.total - ct).toFixed(1)) : null;
  const diffTxt = (diff === null) ? '—' : (diff === 0 ? '—' : (diff > 0 ? `+${fmt(diff)}` : `${fmt(diff)}`));
  const diffClass = diff === null ? '' : (diff > 0 ? 'bad' : (diff < 0 ? 'good' : ''));

  // YTD extras from /summary
  const stormsYTD = extra?.ytd?.stormsCount ?? '—';
  const maxWYTD   = (extra?.ytd?.maxWind ? `${Math.round(extra.ytd.maxWind/5)*5} kt` : '—');
  const parYTD    = extra?.ytd?.parCount ?? '—';

  return `<tr class="${row.isCurrent ? 'current' : ''}" data-year="${row.year}">
    <td class="rank">${row.rank}</td>
    <td class="year-cell">${row.year}</td>
    <td>${fmt(row.total)}</td>
    <td class="diff ${diffClass}">${diffTxt}</td>
    <td>${stormsYTD}</td>
    <td>${maxWYTD}</td>
    <td>${parYTD}</td>
  </tr>`;
}

// Build the scrollable YTD table and center on the current year
async function renderTable(ranks){
  const wrap = el('ranksTable');
  wrap.innerHTML = '';

  // fetch extra per-year YTD info in parallel (all years use the same month/day cutoff)
  const cutoff = ranks.asOf;                          // "YYYY-MM-DD"
  const years  = ranks.window.map(r => r.year);
  const results = await Promise.allSettled(years.map(y => fetchSummary(y, cutoff)));

  const extraByYear = new Map();
  results.forEach((p, i) => {
    if (p.status === 'fulfilled') extraByYear.set(years[i], p.value);
  });

  const currentTotal = ranks.current.total;

  // scrollable container
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';

  // table + header
  const tbl = document.createElement('table');
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Rank</th>
        <th>Year</th>
        <th>YTD ACE</th>
        <th>Δ vs current</th>
        <th>Storms (YTD)</th>
        <th>Max 1-min (YTD)</th>
        <th>PAR entries (YTD)</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const tbody = tbl.querySelector('tbody');

  // add rows — makeRowHTML returns a full <tr>…</tr>, so insert the HTML directly
  ranks.window.forEach(row => {
    const extra = extraByYear.get(row.year);
    tbody.insertAdjacentHTML('beforeend', makeRowHTML(row, extra, currentTotal));
  });

  scroller.appendChild(tbl);
  wrap.appendChild(scroller);

  // center on the current year row after layout
  requestAnimationFrame(() => {
    const cur = scroller.querySelector('tr.current');
    if (cur) cur.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
}




async function refresh(){
  const year   = Number(el('yearSelect').value);
  const cutoff = el('cutoffDate').value;

  try{
    renderStatus('Loading …');
    const ranks = await fetchRanks(year, cutoff);
    renderTop(ranks);
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