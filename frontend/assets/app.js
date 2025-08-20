/* global Chart */
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function cssVar(name, fallback){ 
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); 
  return v || fallback; 
}
const C_PRIMARY = cssVar('--sk-primary', '#22d3ee');
const C_ACCENT  = cssVar('--sk-accent',  '#a78bfa');
const C_WARN    = cssVar('--sk-warn',    '#f59e0b');
const C_MUTED   = cssVar('--sk-muted',   '#94a3b8');


const els = {
  // YTD/cutoff card
  ytdCurrent: document.getElementById('ytdCurrent'),
  ytdAvg: document.getElementById('ytdAvg'),
  ytdPct: document.getElementById('ytdPct'),
  ytdDate: document.getElementById('ytdDate'),
  // controls & cards
  yearSelect: document.getElementById('yearSelect'),
  cutoffDate: document.getElementById('cutoffDate'),
  asOf: document.getElementById('asOf'),
  aceTotal: document.getElementById('aceTotal'),
  stormsCount: document.getElementById('stormsCount'),
  parEntries: document.getElementById('parEntries'),
  strongestWind: document.getElementById('strongestWind'),
  lowestPres: document.getElementById('lowestPres'),
  dTD: document.getElementById('dTD'),
  dTS: document.getElementById('dTS'),
  dSTS: document.getElementById('dSTS'),
  dTY: document.getElementById('dTY'),
  dSTY: document.getElementById('dSTY'),
  activeCount: document.getElementById('activeCount'),
  stormsTable: document.getElementById('stormsTable')
};

let charts = { par:null, ace:null, formed:null, ytd:null };

function fmt(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function fmtWind(w){
  if (!Number.isFinite(w) || w <= 0) return '—';
  const r5 = Math.round(w / 5) * 5;
  return `${r5} kt`;
}

function fmtPres(p){ return Number.isFinite(p) && p > 0 ? `${p} hPa` : '—'; }
function ymd(d){ const dt = new Date(d); return isNaN(dt) ? '' : dt.toISOString().slice(0,10); }

function defaultCutoffForYear(y){
  const nowY = new Date().getUTCFullYear();
  return (y < nowY) ? `${y}-12-31` : new Date().toISOString().slice(0,10);
}

function ensureChart(ctx, type, data, options){
  if (ctx._chart) { ctx._chart.destroy(); }
  const chart = new Chart(ctx, { type, data, options });
  ctx._chart = chart;
  return chart;
}

// ----------------------- data loaders -----------------------
async function loadSummary(year, cutoff){
  const qs = cutoff ? `&cutoff=${cutoff}` : '';
  const res = await fetch(`/api/summary?year=${year}${qs}`);
  if (!res.ok) throw new Error('summary failed');
  return res.json();
}
async function loadActiveBDecks(year){
  const res = await fetch(`/api/current/bdecks?year=${year}&max=30`);
  if (!res.ok) throw new Error('bdecks failed');
  return res.json();
}
async function loadCutoff(year, cutoff){
  const res = await fetch(`/api/ace/cutoff?year=${year}&cutoff=${cutoff}&base_start=1950&base_end=2024`);
  if (!res.ok) throw new Error('cutoff failed');
  return res.json();
}

// ----------------------- renderers --------------------------
function renderCutoff(d){
  els.ytdDate.textContent = d.asOf;
  els.ytdCurrent.textContent = fmt(d.current);
  els.ytdAvg.textContent = fmt(d.average);
  els.ytdPct.textContent = d.pctOfAverage != null ? `${d.pctOfAverage}%` : '—';

  const ctx = document.getElementById('ytdChart').getContext('2d');
  if (charts.ytd) charts.ytd.destroy();
  charts.ytd = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        {
          label: `YTD ${d.year}`,
          data: d.monthly.currentCum,
          borderWidth: 3,
          pointRadius: 3,
          borderColor: C_PRIMARY,
          backgroundColor: 'rgba(34,211,238,0.15)',
          fill: true
        },
        {
          label: `Avg 1950–2024`,
          // <-- prefer full-year climatology; fall back to cutoff-limited if needed
          data: (d.monthly.averageFullCum || d.monthly.averageCum),
          borderWidth: 2,
          pointRadius: 0,
          borderColor: C_MUTED,
          borderDash: [6,4],
          fill: false
        }
      ],
    },
    options: {
      responsive:true,
      maintainAspectRatio:false,
      scales:{ y:{ beginAtZero:true, title:{ display:true, text:'ACE' }}}
    }
  });
}


function renderSummary(data){
  const { year, asOf, ace, categoryDays, par, stormsByMonth, storms } = data;
  els.asOf.textContent = `Updated: ${new Date(asOf).toLocaleString()}`;
  els.aceTotal.textContent = fmt(ace.total);
  els.stormsCount.textContent = storms.length;
  els.parEntries.textContent = par.total;

  // strongest + lowest
  let maxW = 0; let minP = null;
  storms.forEach(s => {
    if (s.maxWind > maxW) maxW = s.maxWind;
    if (Number.isFinite(s.minPres)) minP = minP==null ? s.minPres : Math.min(minP, s.minPres);
  });
  els.strongestWind.textContent = fmtWind(maxW);
  els.lowestPres.textContent = fmtPres(minP);

  // category days
  const avg = (data.categoryDaysClimo && data.categoryDaysClimo.average) || {TD:0,TS:0,STS:0,TY:0,STY:0};
  els.dTD.textContent  = `${fmt(categoryDays.TD)} (${fmt(avg.TD)}) days`;
  els.dTS.textContent  = `${fmt(categoryDays.TS)} (${fmt(avg.TS)}) days`;
  els.dSTS.textContent = `${fmt(categoryDays.STS)} (${fmt(avg.STS)}) days`;
  els.dTY.textContent  = `${fmt(categoryDays.TY)} (${fmt(avg.TY)}) days`;
  els.dSTY.textContent = `${fmt(categoryDays.STY)} (${fmt(avg.STY)}) days`;

  // charts
  const parCtx = document.getElementById('parChart').getContext('2d');
  charts.par = ensureChart(parCtx, 'bar', {
    labels: months,
    datasets:[{ label: `PAR entries ${year}`, data: par.monthly, backgroundColor: C_WARN, borderRadius: 6 }]
  }, { responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true }}});

  const aceCtx = document.getElementById('aceChart').getContext('2d');
  charts.ace = ensureChart(aceCtx, 'line', {
    labels: months,
    datasets:[{ label:`ACE ${year}`, data: ace.monthly, borderColor: C_PRIMARY, borderWidth:3, fill:false, pointRadius:3 }]
  }, { responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true, title:{ display:true, text:'ACE' }}}});

  const stormCtx = document.getElementById('stormChart').getContext('2d');
  charts.formed = ensureChart(stormCtx, 'bar', {
    labels: months,
    datasets:[{ label: `Storms formed ${year}`, data: stormsByMonth, backgroundColor: C_ACCENT, borderRadius: 6 }]
  }, { responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true }}});

  // Top storms table (with PAR First In)
  const tbl = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
      <th>ATCF</th><th>Name</th><th>Start</th><th>End</th>
      <th>Max Wind</th><th>Min Pres</th><th>ACE</th><th>PAR First In</th>
    </tr>`;
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  storms.slice().sort((a,b)=> b.ace - a.ace).forEach(s => {
    const parIn = s.parInDate ? ymd(s.parInDate) : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.id || ''}</td>
      <td>${s.name || ''}</td>
      <td>${ymd(s.start)}</td>
      <td>${ymd(s.end)}</td>
      <td>${fmtWind(s.maxWind)}</td>
      <td>${fmtPres(s.minPres)}</td>
      <td>${fmt(s.ace)}</td>
      <td>${parIn}</td>`;
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  els.stormsTable.innerHTML='';
  els.stormsTable.appendChild(tbl);
}

function renderActive(data){
  els.activeCount.textContent = String((data.storms||[]).length);
}

// ----------------------- boot & events -----------------------
function buildYearSelect(){
  const nowY = new Date().getUTCFullYear();
  for (let y = nowY; y >= 1950; y--){
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    els.yearSelect.appendChild(opt);
  }
  els.yearSelect.value = nowY;
  els.cutoffDate.value = defaultCutoffForYear(nowY);

  els.yearSelect.addEventListener('change', () => {
    const y = Number(els.yearSelect.value);
    els.cutoffDate.value = defaultCutoffForYear(y);
    loadAll();
  });
  els.cutoffDate.addEventListener('change', loadAll);
}

async function loadAll(){
  const year = Number(els.yearSelect.value);
  const cutoff = els.cutoffDate.value || defaultCutoffForYear(year);
  try{
    const [summary, active, cutoffData] = await Promise.all([
      loadSummary(year, cutoff),
      loadActiveBDecks(year),
      loadCutoff(year, cutoff)
    ]);
    renderSummary(summary);
    renderActive(active);
    renderCutoff(cutoffData);
  }catch(e){
    console.error(e);
    els.activeCount.textContent = 'Failed to load: ' + e.message;
  }
}

(function init(){
  Chart.defaults.font.family = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  Chart.defaults.color = '#333';
  buildYearSelect();
  loadAll();
})();
