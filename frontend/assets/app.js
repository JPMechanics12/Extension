/* global Chart */

// simple callout plugin used only on the daily YTD chart
const calloutPlugin = {
  id: 'callout',
  afterDatasetsDraw(chart, _args, _pluginOptions){
    const opts = chart.options.plugins && chart.options.plugins.callout;
    if (!opts) return;

    const { index, value, lines } = opts;
    if (index == null || value == null) return;

    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(index);
    const y = scales.y.getPixelForValue(value);

    ctx.save();
    ctx.font = '12px Inter, -apple-system, system-ui, sans-serif';
    const lh = 15;
    const w = 12 + Math.max(...lines.map(t => ctx.measureText(t).width)) + 12;
    const h = 10 + lines.length * lh + 6;

    // place box above and a bit right of the last point, clamped to chart area
    let bx = Math.min(chartArea.right - w - 6, Math.max(chartArea.left + 6, x + 8));
    let by = Math.max(chartArea.top + 6, y - h - 10);

    // box
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(2,6,23,0.15)';
    ctx.lineWidth = 1;
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + w - r, by);
    ctx.quadraticCurveTo(bx + w, by, bx + w, by + r);
    ctx.lineTo(bx + w, by + h - r);
    ctx.quadraticCurveTo(bx + w, by + h, bx + w - r, by + h);
    ctx.lineTo(bx + r, by + h);
    ctx.quadraticCurveTo(bx, by + h, bx, by + h - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // text
    ctx.fillStyle = '#0b1220';
    lines.forEach((t,i)=> ctx.fillText(t, bx + 12, by + 18 + i*lh));
    ctx.restore();
  }
};



const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function cssVar(name, fallback){ 
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); 
  return v || fallback; 
}
const C_PRIMARY = cssVar('--sk-primary', '#22d3ee');
const C_ACCENT  = cssVar('--sk-accent',  '#a78bfa');
const C_WARN    = cssVar('--sk-warn',    '#f59e0b');
const C_MUTED   = cssVar('--sk-muted',   '#94a3b8');

let resolution = 'monthly';
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
  stormsTable: document.getElementById('stormsTable'),
  resMonthly: document.getElementById('btnMonthly'),
  resDaily: document.getElementById('btnDaily'),
};
async function loadDaily(year, cutoff){
  const res = await fetch(`/api/ace/daily?year=${year}&end=${cutoff}&base_start=1950&base_end=2024`);
  if (!res.ok) throw new Error('daily failed');
  return res.json();
}

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


function renderDaily(d){
  // Card numbers
  els.ytdDate.textContent = d.asOf;
  els.ytdCurrent.textContent = fmt(d.current.total);
  const avgToDate = d.average.cum[d.average.cum.length - 1] || 0;
  els.ytdAvg.textContent = fmt(avgToDate);
  els.ytdPct.textContent = avgToDate > 0 ? `${Math.round((d.current.total/avgToDate)*100)}%` : '—';

  // month ticks
  const monthTickIdx = new Set();
  for (let i = 0; i < d.labels.length; i++) {
    const dt = new Date(d.labels[i] + 'T00:00:00Z');
    if (dt.getUTCDate() === 1) monthTickIdx.add(i);
  }

  const ctx = document.getElementById('ytdChart').getContext('2d');
  if (charts.ytd) charts.ytd.destroy();

  // build datasets: bands first (drawn under), then mean & current on top
  const bandColorRange = 'rgba(16,185,129,0.10)';   // green-ish
  const bandColor1sd   = 'rgba(16,185,129,0.18)';
  const bandColor05sd  = 'rgba(16,185,129,0.28)';

  const ds = [];

  if (d.bands) {
    // Range (min..max)
    ds.push(
      { label:'__range-low', data: d.bands.range.low,  borderColor:'transparent', pointRadius:0, fill:false, backgroundColor:bandColorRange, order:-10 },
      { label:'Range',       data: d.bands.range.high, borderColor:'transparent', pointRadius:0, fill:'-1', backgroundColor:bandColorRange, order:-10 }
    );
    // ±1σ
    ds.push(
      { label:'__1sd-low', data: d.bands.sd1.low,  borderColor:'transparent', pointRadius:0, fill:false, backgroundColor:bandColor1sd, order:-9 },
      { label:'1 S.D.',     data: d.bands.sd1.high, borderColor:'transparent', pointRadius:0, fill:'-1', backgroundColor:bandColor1sd, order:-9 }
    );
    // ±0.5σ
    ds.push(
      { label:'__05sd-low', data: d.bands.sd05.low,  borderColor:'transparent', pointRadius:0, fill:false, backgroundColor:bandColor05sd, order:-8 },
      { label:'0.5 S.D.',   data: d.bands.sd05.high, borderColor:'transparent', pointRadius:0, fill:'-1', backgroundColor:bandColor05sd, order:-8 }
    );
  }

  // Average line
  ds.push({
    label: 'Avg 1950–2024',
    data: d.average.cum,
    borderWidth: 2,
    pointRadius: 0,
    borderColor: C_MUTED,
    borderDash: [6,4],
    fill: false,
    order: 5
  });

  // Current (daily cumulative)
  ds.push({
    label: `YTD ${d.year} (daily)`,
    data: d.current.cum,
    borderWidth: 2,
    pointRadius: 0,
    borderColor: C_PRIMARY,
    backgroundColor: 'rgba(34,211,238,0.12)',
    fill: true,
    order: 10
  });

  const lastIdx = d.current.cum.length - 1;

  charts.ytd = new Chart(ctx, {
    type: 'line',
    data: { labels: d.labels, datasets: ds },
    plugins: [calloutPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          offset: true,
          ticks: {
            autoSkip: false, maxRotation: 0, minRotation: 0,
            callback: (_value, index) => {
              if (!monthTickIdx.has(index)) return '';
              const dt = new Date(d.labels[index] + 'T00:00:00Z');
              return months[dt.getUTCMonth()];
            },
            padding: 6
          },
          grid: {
            color: (c) => monthTickIdx.has(c.index)
              ? 'rgba(148,163,184,0.35)'
              : 'rgba(148,163,184,0.12)',
            lineWidth: (c) => monthTickIdx.has(c.index) ? 1.2 : 0.6
          }
        },
        y: { beginAtZero: true, title: { display: true, text: 'ACE' } }
      },
      plugins: {
        legend: {
          labels: {
            // hide helper datasets from legend (those starting with "__")
            filter: (item) => !item.text || !item.text.startsWith('__')
          }
        },
        // options read by our calloutPlugin
        callout: {
          index: lastIdx,
          value: d.current.cum[lastIdx],
          lines: [
            `ACE: ${fmt(d.current.total)}`,
            `Avg: ${fmt(avgToDate)}`,
            d.rank ? `Rank: ${d.rank.high}/${d.rank.of}` : ''
          ].filter(Boolean)
        },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const i = items[0].dataIndex;
              const curD = d.current.daily[i] ?? 0;
              const avgD = d.average.daily[i] ?? 0;
              return [`Daily: ${fmt(curD)} (avg ${fmt(avgD)})`];
            }
          }
        }
      }
    }
  });
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
      scales:{ x: {
      offset: true,                 // <- new (keeps Jan/Dec inside)
      ticks: { padding: 6 }         // <- small in-axis padding
    },
    y:{ beginAtZero:true, title:{ display:true, text:'ACE' }}}
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
    const [summary, active] = await Promise.all([
      loadSummary(year, cutoff),
      loadActiveBDecks(year),
    ]);
    renderSummary(summary);
    renderActive(active);

    if (resolution === 'daily'){
      const daily = await loadDaily(year, cutoff);
      renderDaily(daily);
    } else {
      const cutoffData = await loadCutoff(year, cutoff);
      renderCutoff(cutoffData);
    }
  }catch(e){
    console.error(e);
    els.activeCount.textContent = 'Failed to load: ' + e.message;
  }
}


(function init(){
  Chart.defaults.font.family = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  Chart.defaults.color = '#333';
  buildYearSelect();

  // resolution toggle
  const btnM = document.getElementById('btnMonthly');
  const btnD = document.getElementById('btnDaily');
  btnM?.addEventListener('click', () => {
    resolution = 'monthly';
    btnM.classList.add('active'); btnD.classList.remove('active');
    loadAll();
  });
  btnD?.addEventListener('click', () => {
    resolution = 'daily';
    btnD.classList.add('active'); btnM.classList.remove('active');
    loadAll();
  });

  loadAll();
})();
