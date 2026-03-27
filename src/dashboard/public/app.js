/* ── NanoClaw Financial Dashboard ─────────────────────────── */

const C = {
  bg:'#151718', panel:'#1e2021', card:'#282a2b',
  border:'#2a3a40', muted:'#8a9da6', accent:'#43a5d5',
  text:'#d0d4d7', hi:'#eef0f2', max:'#ffffff',
  red:'#Cd3f45', orange:'#db7b55', yellow:'#e6cd69',
  green:'#9fca56', cyan:'#55dbbe', blue:'#55b5db',
  purple:'#a074c4', brown:'#8a553f',
};
const COLORS = [C.blue, C.green, C.yellow, C.purple, C.cyan, C.orange, C.red, C.brown, C.accent];

Chart.defaults.color = C.muted;
Chart.defaults.borderColor = 'rgba(42,58,64,0.4)';
Chart.defaults.font.family = "-apple-system,'SF Pro Text','Inter',system-ui,sans-serif";
Chart.defaults.font.size = 12;

let DATA, categoryMap = {}, debitsNeg = false, currency = 'CAD';
let txPage = 0, filteredTx = [], allTx = [];
let txSort = { col: 'date', dir: -1 };
const TX_PP = 30;

// ── Filter state (all chart clicks + controls feed into this) ──
const filters = {
  day: null,        // '2026-03-15'
  weekStart: null,  // '2026-03-10' (Mon of that week)
  weekEnd: null,    // '2026-03-16' (Sun)
  category: null,   // category name string
  merchant: null,   // payee string
  search: '',
  catId: '',
  dateRange: '90days',
};

// Chart-stored data for highlight updates
let dailyDates = [], weeklyKeys = [];

// ── Helpers ─────────────────────────────────────────────────

const $ = s => document.getElementById(s);
let privacyMode = localStorage.getItem('privacy') === '1';

function _fmt(n, cur, dec) {
  cur = (cur || currency).toUpperCase();
  n = typeof n === 'string' ? parseFloat(n) : n;
  if (privacyMode) {
    const s = n < 0 ? '-' : '';
    return `${s}$••,•••${dec ? '.••' : ''}`;
  }
  return new Intl.NumberFormat('en-CA', { style:'currency', currency:cur, minimumFractionDigits:dec, maximumFractionDigits:dec }).format(n);
}
const fmt = (n, cur) => _fmt(n, cur, 0);
const fmtFull = (n, cur) => _fmt(n, cur, 2);
function fmtDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
function buildCategoryMap(categories) {
  const m = {};
  for (const c of categories) { m[c.id] = c; if (c.children) for (const ch of c.children) m[ch.id] = ch; }
  return m;
}
function spendAmt(tx) { const v = parseFloat(tx.amount); return debitsNeg ? -v : v; }

const EXCLUDED_CATS = ['payment, transfer', 'transfer', 'payment', 'investment'];
function isSpend(tx) {
  if (tx.is_income || tx.exclude_from_totals) return false;
  const c = categoryMap[tx.category_id];
  if (c?.is_income) return false;
  if (c && EXCLUDED_CATS.includes(c.name.toLowerCase())) return false;
  return spendAmt(tx) > 0;
}
function isIncome(tx) {
  if (tx.exclude_from_totals) return false;
  if (tx.is_income) return true;
  const c = categoryMap[tx.category_id];
  if (c?.is_income) return true;
  // Negative amount (credit) with income-ish category
  const names = ['income','wages','dividends','interest earned','rental income','tax refund'];
  if (c && names.includes(c.name.toLowerCase())) return true;
  return false;
}
function relTime(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now'; if (m < 60) return m+'m'; const h = Math.floor(m/60);
  if (h < 24) return h+'h'; return Math.floor(h/24)+'d';
}
function normType(t) {
  if (!t) return 'other'; t = t.toLowerCase();
  if (t.includes('depository') || t === 'cash') return 'cash';
  if (t.includes('credit')) return 'credit';
  if (t.includes('investment') || t.includes('brokerage')) return 'investment';
  if (t.includes('loan') || t.includes('mortgage')) return 'loan';
  return 'other';
}
function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function toISO(d) { return d.toISOString().slice(0,10); }
function weekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { start: toISO(mon), end: toISO(sun) };
}

// ── Fetch ───────────────────────────────────────────────────

async function fetchDash(refreshBal) {
  const r = await fetch(`/api/dashboard${refreshBal ? '?refreshBalances=true' : ''}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Render ──────────────────────────────────────────────────

function render(data) {
  DATA = data;
  debitsNeg = data.user.debits_as_negative ?? false;
  currency = data.user.primary_currency;
  categoryMap = buildCategoryMap(data.categories);

  const ca = data.cachedAt;
  $('cache-info').textContent = [ca.balances && `bal ${relTime(ca.balances)}`, ca.transactions && `tx ${relTime(ca.transactions)}`].filter(Boolean).join(' · ');

  renderNetWorth(data.accounts);
  renderIncome(data.transactions);
  renderAccounts(data.accounts);
  renderDonut(data.transactions);
  renderDaily(data.transactions);
  renderWeekly(data.transactions);
  renderMerchants(data.transactions);
  setupTx(data.transactions);

  $('loading').classList.add('hidden');
  $('app').classList.remove('hidden');
}

// ── Net Worth ───────────────────────────────────────────────

function renderNetWorth(accounts) {
  const g = {};
  for (const a of accounts) {
    const t = normType(a.type); if (!g[t]) g[t] = 0;
    const b = a.to_base != null ? a.to_base : parseFloat(a.balance);
    if (t === 'credit') g[t] += b;
    else if (t === 'loan') g[t] -= Math.abs(b);
    else g[t] += b;
  }
  $('net-worth').textContent = fmt(Object.values(g).reduce((s,v) => s+v, 0));

  const bd = $('nw-breakdown'); bd.innerHTML = '';
  for (const [k,lbl] of [['cash','Cash'],['investment','Invest'],['credit','Credit'],['loan','Loans']]) {
    if (g[k] === undefined) continue;
    const v = g[k], pill = document.createElement('div');
    pill.className = 'nw-pill';
    pill.innerHTML = `<span class="nw-pill-label">${lbl}</span><span class="nw-pill-val ${v>=0?'pos':'neg'}">${fmt(v)}</span>`;
    bd.appendChild(pill);
  }
}

// ── Income vs Spending (this month) ─────────────────────────

function renderIncome(transactions) {
  const now = new Date();
  const ms = toISO(monthStart(now)), me = toISO(now);
  let inc = 0, spend = 0;
  for (const tx of transactions) {
    if (tx.date < ms || tx.date > me) continue;
    const amt = spendAmt(tx);
    if (isIncome(tx)) inc += Math.abs(amt);
    else if (isSpend(tx)) spend += amt;
  }
  const net = inc - spend;
  const el = $('income-spend');
  el.innerHTML = `
    <div class="is-item"><span class="is-label">Income</span><span class="is-val income">${fmt(inc)}</span></div>
    <div class="is-item"><span class="is-label">Spent</span><span class="is-val spend">${fmt(spend)}</span></div>
    <div class="is-item"><span class="is-label">Net</span><span class="is-val ${net>=0?'net-pos':'net-neg'}">${fmt(net)}</span></div>
  `;
}

// ── Accounts ────────────────────────────────────────────────

function renderAccounts(accounts) {
  const list = $('account-list'); list.innerHTML = '';
  const typeOrder = ['cash','investment','credit','loan','other'];
  const typeLabels = { cash:'Cash & Checking', investment:'Investments', credit:'Credit Cards', loan:'Loans & Mortgages', other:'Other' };
  const grouped = {};
  for (const a of accounts) { const t = normType(a.type); (grouped[t]||=[]).push(a); }

  for (const type of typeOrder) {
    const accts = grouped[type]; if (!accts?.length) continue;
    const lbl = document.createElement('div'); lbl.className = 'acct-group-label'; lbl.textContent = typeLabels[type] || type;
    list.appendChild(lbl);
    let groupTotal = 0;
    for (const a of accts) {
      const b = a.to_base != null ? a.to_base : parseFloat(a.balance); groupTotal += b;
      const row = document.createElement('div'); row.className = 'acct-row';
      let name = a.display_name || a.name || '—';
      if (a.institution_name && name.startsWith(a.institution_name)) name = name.slice(a.institution_name.length).replace(/^\s+/,'');
      row.innerHTML = `<div style="min-width:0;flex:1"><div class="acct-name">${name}</div></div><span class="acct-bal t-${type}">${fmtFull(a.balance, a.currency)}</span>`;
      list.appendChild(row);
    }
    const tot = document.createElement('div'); tot.className = 'acct-group-total';
    tot.innerHTML = `<span class="agl">${accts.length} account${accts.length>1?'s':''}</span><span class="agv">${fmt(groupTotal)}</span>`;
    list.appendChild(tot);
  }
}

// ── Category Donut (clickable → filter by category) ─────────

let donutChart, donutLabels = [];
function renderDonut(transactions) {
  const now = new Date(), ms = toISO(monthStart(now)), me = toISO(now);
  const byCat = {};
  for (const tx of transactions) {
    if (tx.date >= ms && tx.date <= me && isSpend(tx)) {
      const cn = categoryMap[tx.category_id]?.name || 'Uncategorized';
      byCat[cn] = (byCat[cn]||0) + spendAmt(tx);
    }
  }
  const entries = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  const top = entries.slice(0,7);
  const other = entries.slice(7).reduce((s,[,v]) => s+v, 0);
  if (other > 0) top.push(['Other', other]);
  donutLabels = top.map(e => e[0]);

  function bgColors() {
    return COLORS.slice(0, top.length).map((c, i) =>
      filters.category && donutLabels[i] !== filters.category ? c + '30' : c
    );
  }

  if (donutChart) donutChart.destroy();
  donutChart = new Chart($('chart-category-donut'), {
    type: 'doughnut',
    data: {
      labels: donutLabels,
      datasets: [{ data: top.map(e => e[1]), backgroundColor: bgColors(), borderColor: C.panel, borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      onClick(evt, elements) {
        if (!elements.length) return;
        const label = donutLabels[elements[0].index];
        if (label === 'Other') return;
        setFilter('category', filters.category === label ? null : label);
      },
      plugins: {
        legend: { position:'bottom', labels: { padding:8, usePointStyle:true, pointStyle:'circle', font:{size:11}, color: C.text, boxWidth:8 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtFull(ctx.raw)}` } },
      },
    },
  });
}

// ── Daily Spending (clickable → filter by day) ──────────────

let dailyChart;
function renderDaily(transactions) {
  const now = new Date(), ms = monthStart(now);
  const days = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const byDay = {};
  for (let d=1; d<=days; d++) byDay[`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`] = 0;
  for (const tx of transactions) {
    const td = new Date(tx.date+'T00:00:00');
    if (td >= ms && td <= now && isSpend(tx)) byDay[tx.date] = (byDay[tx.date]||0) + spendAmt(tx);
  }
  dailyDates = Object.keys(byDay).sort();
  const vals = dailyDates.map(d => byDay[d]);
  const cum = []; let s = 0; for (const v of vals) { s+=v; cum.push(s); }

  function barColors() { return dailyDates.map(d => d === filters.day ? C.accent : C.blue+'70'); }
  function barBorders() { return dailyDates.map(d => d === filters.day ? C.accent : 'transparent'); }

  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart($('chart-daily-spending'), {
    type: 'bar',
    data: {
      labels: dailyDates.map(d => d.slice(8)),
      datasets: [
        { label:'Daily', data:vals, backgroundColor:barColors(), borderColor:barBorders(), borderWidth:2, borderRadius:2, order:2 },
        { label:'Cumulative', data:cum, type:'line', borderColor:C.cyan, backgroundColor:'transparent', pointRadius:0, borderWidth:1.5, tension:.3, yAxisID:'y1', order:1 },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      onClick(evt, elements) {
        if (!elements.length) return;
        const clicked = dailyDates[elements[0].index];
        setFilter('day', filters.day === clicked ? null : clicked);
      },
      scales: {
        x: { grid:{display:false}, ticks:{font:{size:12}, maxRotation:0, autoSkip:true, maxTicksLimit:15} },
        y: { beginAtZero:true, ticks:{ callback:v=>fmt(v), font:{size:11} } },
        y1: { position:'right', beginAtZero:true, grid:{display:false}, ticks:{ callback:v=>fmt(v), font:{size:11} } },
      },
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}: ${fmtFull(ctx.raw)}` } } },
    },
  });
}

// ── Weekly Trend (clickable → filter by week) ───────────────

let weeklyChart;
function renderWeekly(transactions) {
  const weeks = {};
  for (const tx of transactions) {
    if (!isSpend(tx)) continue;
    const wr = weekRange(tx.date);
    weeks[wr.start] = (weeks[wr.start]||0) + spendAmt(tx);
  }
  const sorted = Object.entries(weeks).sort((a,b)=>a[0].localeCompare(b[0]));
  weeklyKeys = sorted.map(([k])=>k);
  const labels = sorted.map(([d]) => new Date(d+'T00:00:00').toLocaleDateString('en-CA',{month:'short',day:'numeric'}));
  const vals = sorted.map(([,v])=>v);
  const avg = vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0;
  $('weekly-avg').textContent = `avg ${fmtFull(avg)}/wk`;

  function barColors() {
    return weeklyKeys.map((k,i) => {
      if (filters.weekStart === k) return C.accent + 'dd';
      return vals[i] > avg ? C.orange+'bb' : C.blue+'bb';
    });
  }

  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart($('chart-weekly-trend'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Weekly', data:vals, backgroundColor:barColors(), borderRadius:3 },
        { label:'Avg', data:Array(vals.length).fill(avg), type:'line', borderColor:C.yellow, borderDash:[5,3], borderWidth:1, pointRadius:0, fill:false },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      onClick(evt, elements) {
        if (!elements.length) return;
        const key = weeklyKeys[elements[0].index];
        if (filters.weekStart === key) {
          setFilter('week', null);
        } else {
          const wr = weekRange(key);
          // weekRange returns Mon-Sun but key is already Mon
          const end = new Date(key + 'T00:00:00');
          end.setDate(end.getDate() + 6);
          filters.weekStart = key;
          filters.weekEnd = toISO(end);
          // Clear day filter when selecting a week
          filters.day = null;
          updateChartHighlights();
          applyFilters();
          renderFilterPills();
        }
      },
      scales: {
        x: { grid:{display:false}, ticks:{font:{size:12}, maxRotation:45, autoSkip:true, maxTicksLimit:13} },
        y: { beginAtZero:true, ticks:{ callback:v=>fmt(v), font:{size:11} } },
      },
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}: ${fmtFull(ctx.raw)}` } } },
    },
  });
}

// ── Top Merchants (clickable → filter by merchant) ──────────

let merchantChart, merchantLabels = [];
function renderMerchants(transactions) {
  const now = new Date(), ms = toISO(monthStart(now)), me = toISO(now);
  const RECURRING_CATS = ['condo mortgage','mortgage','condo fees','rent'];
  const byM = {};
  for (const tx of transactions) {
    if (tx.date >= ms && tx.date <= me && isSpend(tx)) {
      const c = categoryMap[tx.category_id];
      if (c && RECURRING_CATS.includes(c.name.toLowerCase())) continue;
      const n = tx.payee || tx.original_name || 'Unknown';
      byM[n] = (byM[n]||0) + spendAmt(tx);
    }
  }
  const sorted = Object.entries(byM).sort((a,b)=>b[1]-a[1]).slice(0,8);
  merchantLabels = sorted.map(e=>e[0]);

  function barColors() {
    return COLORS.slice(0, sorted.length).map((c,i) =>
      filters.merchant && merchantLabels[i] !== filters.merchant ? c + '30' : c + 'bb'
    );
  }

  if (merchantChart) merchantChart.destroy();
  merchantChart = new Chart($('chart-top-merchants'), {
    type: 'bar',
    data: {
      labels: merchantLabels,
      datasets: [{ data:sorted.map(e=>e[1]), backgroundColor:barColors(), borderRadius:3 }],
    },
    options: {
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      onClick(evt, elements) {
        if (!elements.length) return;
        const label = merchantLabels[elements[0].index];
        setFilter('merchant', filters.merchant === label ? null : label);
      },
      scales: {
        x: { beginAtZero:true, ticks:{ callback:v=>fmt(v), font:{size:11} } },
        y: { ticks:{ font:{size:11}, color:C.text, callback(v) { const l=this.getLabelForValue(v); return l.length>20?l.slice(0,18)+'…':l; } } },
      },
      plugins: { legend:{display:false}, tooltip:{ callbacks:{label:ctx=>` ${fmtFull(ctx.raw)}`} } },
    },
  });
}

// ── Filter management ───────────────────────────────────────

function setFilter(type, value) {
  switch (type) {
    case 'day':
      filters.day = value;
      filters.weekStart = null; filters.weekEnd = null; // clear week when picking a day
      break;
    case 'week':
      filters.weekStart = null; filters.weekEnd = null;
      filters.day = null;
      break;
    case 'category':
      filters.category = value;
      break;
    case 'merchant':
      filters.merchant = value;
      break;
  }
  updateChartHighlights();
  applyFilters();
  renderFilterPills();
}

function clearAllFilters() {
  filters.day = null; filters.weekStart = null; filters.weekEnd = null;
  filters.category = null; filters.merchant = null;
  filters.search = ''; filters.catId = '';
  $('tx-search').value = '';
  $('tx-category-filter').value = '';
  $('tx-date-range').value = '90days';
  filters.dateRange = '90days';
  updateChartHighlights();
  applyFilters();
  renderFilterPills();
}

function hasActiveFilters() {
  return filters.day || filters.weekStart || filters.category || filters.merchant || filters.search || filters.catId;
}

function renderFilterPills() {
  const el = $('filter-pills'); el.innerHTML = '';
  const pills = [];
  if (filters.day) pills.push({ label: `Day: ${fmtDate(filters.day)}`, clear: () => setFilter('day', null) });
  if (filters.weekStart) {
    const ws = fmtDate(filters.weekStart).replace(/,\s*\d{4}$/, '');
    const we = fmtDate(filters.weekEnd).replace(/,\s*\d{4}$/, '');
    pills.push({ label: `Week: ${ws} – ${we}`, clear: () => setFilter('week', null) });
  }
  if (filters.category) pills.push({ label: `Cat: ${filters.category}`, clear: () => setFilter('category', null) });
  if (filters.merchant) pills.push({ label: filters.merchant, clear: () => setFilter('merchant', null) });
  if (filters.search) pills.push({ label: `"${filters.search}"`, clear: () => { filters.search = ''; $('tx-search').value = ''; applyFilters(); renderFilterPills(); } });
  if (filters.catId) {
    const cn = Object.values(categoryMap).find(c => c.id == filters.catId)?.name;
    pills.push({ label: `Cat: ${cn || filters.catId}`, clear: () => { filters.catId = ''; $('tx-category-filter').value = ''; applyFilters(); renderFilterPills(); } });
  }

  for (const p of pills) {
    const pill = document.createElement('span');
    pill.className = 'filter-pill';
    pill.innerHTML = `${p.label}<span class="pill-x">×</span>`;
    pill.querySelector('.pill-x').addEventListener('click', p.clear);
    el.appendChild(pill);
  }
  if (pills.length > 1) {
    const btn = document.createElement('button');
    btn.className = 'clear-all-btn';
    btn.textContent = 'Clear all';
    btn.addEventListener('click', clearAllFilters);
    el.appendChild(btn);
  }
}

function updateChartHighlights() {
  // Daily chart
  if (dailyChart) {
    dailyChart.data.datasets[0].backgroundColor = dailyDates.map(d => d === filters.day ? C.accent : C.blue+'70');
    dailyChart.data.datasets[0].borderColor = dailyDates.map(d => d === filters.day ? C.accent : 'transparent');
    dailyChart.update('none');
  }
  // Weekly chart
  if (weeklyChart) {
    const vals = weeklyChart.data.datasets[0].data;
    const avg = vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0;
    weeklyChart.data.datasets[0].backgroundColor = weeklyKeys.map((k,i) =>
      filters.weekStart === k ? C.accent+'dd' : (vals[i]>avg ? C.orange+'bb' : C.blue+'bb')
    );
    weeklyChart.update('none');
  }
  // Donut
  if (donutChart) {
    donutChart.data.datasets[0].backgroundColor = COLORS.slice(0, donutLabels.length).map((c,i) =>
      filters.category && donutLabels[i] !== filters.category ? c + '30' : c
    );
    donutChart.update('none');
  }
  // Merchants
  if (merchantChart) {
    merchantChart.data.datasets[0].backgroundColor = COLORS.slice(0, merchantLabels.length).map((c,i) =>
      filters.merchant && merchantLabels[i] !== filters.merchant ? c + '30' : c + 'bb'
    );
    merchantChart.update('none');
  }
}

// ── Transactions ────────────────────────────────────────────

function getDateRange() {
  const now = new Date();
  switch (filters.dateRange) {
    case 'thisMonth': return { from: toISO(monthStart(now)), to: toISO(now) };
    case 'lastMonth': {
      const lm = new Date(now.getFullYear(), now.getMonth()-1, 1);
      const lme = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toISO(lm), to: toISO(lme) };
    }
    case '90days': {
      const d = new Date(now); d.setDate(d.getDate()-90);
      return { from: toISO(d), to: toISO(now) };
    }
    default: return { from: '2000-01-01', to: '2099-12-31' };
  }
}

function setupTx(transactions) {
  const cf = $('tx-category-filter');
  const seen = new Set(); cf.innerHTML = '<option value="">All Categories</option>';
  const catNames = [];
  for (const tx of transactions) {
    const c = categoryMap[tx.category_id];
    if (c && !seen.has(c.id)) { seen.add(c.id); catNames.push([c.id, c.name]); }
  }
  catNames.sort((a,b) => a[1].localeCompare(b[1]));
  for (const [id, name] of catNames) {
    const o = document.createElement('option'); o.value = id; o.textContent = name; cf.appendChild(o);
  }

  allTx = [...transactions];
  txSort = { col: 'date', dir: -1 };
  txPage = 0;

  // Wire up controls — remove old listeners by replacing elements
  const searchEl = $('tx-search');
  const newSearch = searchEl.cloneNode(true);
  searchEl.replaceWith(newSearch);
  newSearch.id = 'tx-search';
  newSearch.addEventListener('input', () => { filters.search = newSearch.value.toLowerCase(); applyFilters(); renderFilterPills(); });

  const newCf = cf.cloneNode(true);
  cf.replaceWith(newCf);
  newCf.id = 'tx-category-filter';
  newCf.addEventListener('change', () => { filters.catId = newCf.value; applyFilters(); renderFilterPills(); });

  const drEl = $('tx-date-range');
  const newDr = drEl.cloneNode(true);
  drEl.replaceWith(newDr);
  newDr.id = 'tx-date-range';
  newDr.addEventListener('change', () => { filters.dateRange = newDr.value; applyFilters(); });

  const prevEl = $('tx-prev'), nextEl = $('tx-next');
  const newPrev = prevEl.cloneNode(true), newNext = nextEl.cloneNode(true);
  prevEl.replaceWith(newPrev); nextEl.replaceWith(newNext);
  newPrev.id = 'tx-prev'; newNext.id = 'tx-next';
  newPrev.addEventListener('click', () => { txPage--; renderPage(); });
  newNext.addEventListener('click', () => { txPage++; renderPage(); });

  // Sortable headers
  document.querySelectorAll('.tx-table th.sortable').forEach(th => {
    const newTh = th.cloneNode(true);
    th.replaceWith(newTh);
    newTh.addEventListener('click', () => {
      const col = newTh.dataset.sort;
      if (txSort.col === col) txSort.dir *= -1;
      else { txSort.col = col; txSort.dir = col === 'amount' ? -1 : 1; }
      updateSortArrows();
      applyFilters();
    });
  });
  updateSortArrows();
  applyFilters();
  renderFilterPills();
}

function updateSortArrows() {
  document.querySelectorAll('.tx-table th.sortable').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    const isActive = th.dataset.sort === txSort.col;
    th.classList.toggle('active', isActive);
    arrow.textContent = isActive ? (txSort.dir === 1 ? '↑' : '↓') : '';
  });
}

function txSortKey(tx) {
  switch (txSort.col) {
    case 'date': return tx.date;
    case 'payee': return (tx.payee || tx.original_name || '').toLowerCase();
    case 'category': return (categoryMap[tx.category_id]?.name || '').toLowerCase();
    case 'amount': return spendAmt(tx);
    default: return '';
  }
}

function hasChartFilter() {
  return filters.day || filters.weekStart || filters.category || filters.merchant;
}

function applyFilters() {
  const { from, to } = getDateRange();
  const chartActive = hasChartFilter();
  filteredTx = allTx.filter(tx => {
    // Date range
    if (tx.date < from || tx.date > to) return false;
    // When any chart filter is active, exclude categories that charts never show
    if (chartActive) {
      const c = categoryMap[tx.category_id];
      if (c && EXCLUDED_CATS.includes(c.name.toLowerCase())) return false;
    }
    // Chart filters
    if (filters.day && tx.date !== filters.day) return false;
    if (filters.weekStart && (tx.date < filters.weekStart || tx.date > filters.weekEnd)) return false;
    if (filters.category) {
      const cn = categoryMap[tx.category_id]?.name || 'Uncategorized';
      if (cn !== filters.category) return false;
    }
    if (filters.merchant) {
      const p = tx.payee || tx.original_name || '';
      if (p !== filters.merchant) return false;
    }
    // Control filters
    if (filters.search && !(tx.payee||'').toLowerCase().includes(filters.search) && !(tx.original_name||'').toLowerCase().includes(filters.search)) return false;
    if (filters.catId && tx.category_id != filters.catId) return false;
    return true;
  });

  // Sort
  const dir = txSort.dir, isNum = txSort.col === 'amount';
  filteredTx.sort((a, b) => {
    const ka = txSortKey(a), kb = txSortKey(b);
    if (isNum) return (ka - kb) * dir;
    return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
  });

  txPage = 0; renderPage();
}

function renderPage() {
  const tbody = $('tx-body');
  const start = txPage * TX_PP;
  const page = filteredTx.slice(start, start + TX_PP);
  const total = Math.max(1, Math.ceil(filteredTx.length / TX_PP));

  tbody.innerHTML = '';
  for (const tx of page) {
    const cat = categoryMap[tx.category_id];
    const amt = spendAmt(tx);
    const isCr = amt < 0;
    const inc = isIncome(tx);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="date">${fmtDate(tx.date)}</td>
      <td class="payee">${tx.payee || tx.original_name || '—'}</td>
      <td class="cat">${cat?.name || '—'}</td>
      <td class="r ${isCr || inc ? 'credit' : 'debit'}">${isCr ? '+' : ''}${fmtFull(Math.abs(amt), tx.currency)}</td>
    `;
    tbody.appendChild(tr);
  }

  $('tx-page-info').textContent = filteredTx.length ? `${start+1}–${Math.min(start+TX_PP, filteredTx.length)} of ${filteredTx.length}` : 'No transactions';
  $('tx-prev').disabled = txPage === 0;
  $('tx-next').disabled = txPage >= total - 1;
}

// ── Init ────────────────────────────────────────────────────

(async () => {
  try { render(await fetchDash()); lucide.createIcons(); }
  catch (err) { $('loading').innerHTML = `<span style="color:${C.red}">Error: ${err.message}</span>`; }

  // Privacy mode
  const privBtn = $('privacy-btn');
  function syncPrivacyBtn() {
    privBtn.classList.toggle('active', privacyMode);
    privBtn.innerHTML = privacyMode ? '<i data-lucide="eye-off"></i>' : '<i data-lucide="eye"></i>';
    lucide.createIcons();
  }
  syncPrivacyBtn();
  privBtn.addEventListener('click', () => {
    privacyMode = !privacyMode;
    localStorage.setItem('privacy', privacyMode ? '1' : '0');
    syncPrivacyBtn();
    render(DATA);
  });

  $('refresh-btn').addEventListener('click', async () => {
    const btn = $('refresh-btn'); btn.classList.add('spinning');
    try { render(await fetchDash(true)); } catch(e) { console.error(e); }
    btn.classList.remove('spinning');
  });
})();
