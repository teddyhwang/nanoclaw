/* ── NanoClaw Investment Dashboard ─────────────────────────── */

const C = {
  bg:'#0b0e14', panel:'#131721', card:'#202229', border:'#3e4b59',
  muted:'#6c7a8a', accent:'#59c2ff', text:'#bfbdb6', hi:'#e6e1cf', max:'#f2f0e7',
  red:'#f07178', orange:'#ff8f40', yellow:'#ffb454', green:'#aad94c',
  cyan:'#95e6cb', blue:'#59c2ff', purple:'#d2a6ff', brown:'#e6b450',
};
const COLORS = [C.blue, C.green, C.yellow, C.purple, C.cyan, C.orange, C.red, C.brown, C.accent];

Chart.defaults.color = C.muted;
Chart.defaults.borderColor = 'rgba(42,58,64,0.4)';
Chart.defaults.font.family = "-apple-system,'SF Pro Text','Inter',system-ui,sans-serif";
Chart.defaults.font.size = 12;

let DATA = null;
const charts = {};
const $ = s => document.getElementById(s);
let privacyMode = localStorage.getItem('privacy') === '1';

function _fmtI(n, dec) {
  if (privacyMode) { const s = n < 0 ? '-' : ''; return `${s}$••,•••${dec ? '.••' : ''}`; }
  return new Intl.NumberFormat('en-CA', { style:'currency', currency:'CAD', minimumFractionDigits:dec, maximumFractionDigits:dec }).format(n);
}
const fmt = n => _fmtI(n, 0);
const fmtFull = n => _fmtI(n, 2);
const fmtPct = n => privacyMode ? '•.••%' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const valClass = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const statClass = n => n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';

// ── Fetch ───────────────────────────────────────────────────

async function fetchInvestments() {
  const r = await fetch('/api/investments');
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Init ────────────────────────────────────────────────────

(async () => {
  try {
    DATA = await fetchInvestments();
    buildSubNav();
    const initialView = viewFromPath(location.pathname);
    activateTab(initialView);
    showView(initialView);

    // Privacy mode
    const privBtn = $('privacy-btn');
    function syncPrivBtn() {
      privBtn.classList.toggle('active', privacyMode);
      privBtn.innerHTML = privacyMode ? '<i data-lucide="eye-off"></i>' : '<i data-lucide="eye"></i>';
      lucide.createIcons();
    }
    syncPrivBtn();
    privBtn.addEventListener('click', () => {
      privacyMode = !privacyMode;
      localStorage.setItem('privacy', privacyMode ? '1' : '0');
      syncPrivBtn();
      const view = viewFromPath(location.pathname);
      showView(view);
    });

    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');
    lucide.createIcons();

    // Refresh button
    $('refresh-btn').addEventListener('click', async () => {
      const btn = $('refresh-btn');
      btn.classList.add('spinning');
      try {
        const [newData] = await Promise.all([fetchInvestments(), new Promise(r => setTimeout(r, 500))]);
        DATA = newData;
        const view = viewFromPath(location.pathname);
        renderHeaderStats(view);
        showView(view);
        lucide.createIcons();
      } catch (e) { console.error(e); }
      btn.classList.remove('spinning');
    });
  } catch (err) {
    $('loading').innerHTML = `<span style="color:${C.red}">Error: ${err.message}</span>`;
  }
})();

// ── Sub-nav ─────────────────────────────────────────────────

function buildSubNav() {
  const nav = $('sub-nav');
  const years = Object.keys(DATA.years).sort((a,b) => b-a);
  for (const y of years) {
    const link = document.createElement('a');
    link.className = 'sub-tab';
    link.href = `/investments/${y}`;
    link.dataset.view = `year-${y}`;
    link.textContent = y;
    nav.appendChild(link);
  }

  nav.addEventListener('click', e => {
    const link = e.target.closest('.sub-tab');
    if (!link) return;
    e.preventDefault();
    navigateTo(link.href);
  });
}

function viewFromPath(pathname) {
  const p = pathname.replace(/\/$/, '') || '/investments';
  if (p === '/investments') return 'overview';
  if (p === '/investments/salaries') return 'salaries';
  const yearMatch = p.match(/^\/investments\/(\d{4})$/);
  if (yearMatch) return `year-${yearMatch[1]}`;
  return 'overview';
}

function navigateTo(url) {
  const path = new URL(url, location.origin).pathname;
  history.pushState(null, '', path);
  const view = viewFromPath(path);
  activateTab(view);
  showView(view);
}

function activateTab(view) {
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  const match = document.querySelector(`.sub-tab[data-view="${view}"]`);
  if (match) match.classList.add('active');
}

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const view = viewFromPath(location.pathname);
  activateTab(view);
  showView(view);
});

function showView(view) {
  // Destroy existing charts
  Object.values(charts).forEach(c => c.destroy?.());
  Object.keys(charts).forEach(k => delete charts[k]);

  const container = $('view-container');
  if (view === 'overview') renderOverview(container);
  else if (view === 'salaries') renderSalaries(container);
  else if (view.startsWith('year-')) renderYear(container, view.replace('year-', ''));

  renderHeaderStats(view);
}

function renderHeaderStats(view) {
  const el = $('invest-header-stats');
  const currentYear = Object.keys(DATA.years).sort((a,b) => b-a)[0];
  const cur = DATA.years[currentYear];

  if (view === 'salaries') {
    const sal = DATA.salaries;
    const totalGross = sal.reduce((s,r) => s + r.teddyGross + r.nicoleGross, 0);
    const totalTax = sal.reduce((s,r) => s + r.teddyTax + r.nicoleTax, 0);
    const totalNet = totalGross - totalTax;
    const savPct = totalNet ? (cur.summary.total / totalNet * 100) : 0;
    el.innerHTML = `
      <div class="hdr-stat"><span class="hdr-stat-label">Lifetime Earnings</span><span class="hdr-stat-val hero">${fmt(totalGross)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Lifetime Tax</span><span class="hdr-stat-val neg">${fmt(totalTax)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Lifetime Net</span><span class="hdr-stat-val pos">${fmt(totalNet)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Total Savings</span><span class="hdr-stat-val highlight">${fmt(cur.summary.total)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Savings %</span><span class="hdr-stat-val pos">${savPct.toFixed(1)}%</span></div>
    `;
  } else {
    el.innerHTML = `
      <div class="hdr-stat"><span class="hdr-stat-label">Total Savings</span><span class="hdr-stat-val hero">${fmt(cur.summary.total)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">YTD Return</span><span class="hdr-stat-val ${statClass(cur.returns.total.returnAmount) === 'positive' ? 'pos' : 'neg'}">${fmt(cur.returns.total.returnAmount)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">YTD Return %</span><span class="hdr-stat-val ${statClass(cur.returns.total.returnPct) === 'positive' ? 'pos' : 'neg'}">${fmtPct(cur.returns.total.returnPct)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Total Debt</span><span class="hdr-stat-val neg">${fmt(cur.debt.totalDebt)}</span></div>
      <div class="hdr-stat"><span class="hdr-stat-label">Net Position</span><span class="hdr-stat-val ${cur.subtotal >= 0 ? 'pos' : 'neg'}">${fmt(cur.subtotal)}</span></div>
    `;
  }
}

// ── Overview ────────────────────────────────────────────────

function renderOverview(el) {
  const currentYear = Object.keys(DATA.years).sort((a,b) => b-a)[0];
  const cur = DATA.years[currentYear];
  const pm = DATA.predictionModel;

  el.innerHTML = `
    <div class="ov-grid-2x2">
      <div class="ov-cell">
        <h3>Savings Growth — Actual vs Predicted</h3>
        <div class="ov-chart-area"><canvas id="chart-growth"></canvas></div>
      </div>
      <div class="ov-cell">
        <h3>Savings vs Earnings</h3>
        <div class="ov-chart-area"><canvas id="chart-savings-earnings"></canvas></div>
      </div>
      <div class="ov-cell">
        <h3>Annual Returns %</h3>
        <div class="ov-chart-area"><canvas id="chart-returns"></canvas></div>
      </div>
      <div class="ov-cell">
        <h3>Income vs Tax</h3>
        <div class="ov-chart-area"><canvas id="chart-tax"></canvas></div>
      </div>
    </div>
  `;

  // Growth chart
  const pmYears = pm.years.filter(y => y.predictedSavings > 0);
  charts.growth = new Chart($('chart-growth'), {
    type: 'line',
    data: {
      labels: pmYears.map(y => y.year),
      datasets: [
        { label: 'Actual', data: pmYears.map(y => y.actualSavings), borderColor: C.green, backgroundColor: C.green+'20', fill: true, pointRadius: 3, tension: .3 },
        { label: 'Predicted (10% ROI)', data: pmYears.map(y => y.predictedSavings), borderColor: C.muted, borderDash: [5,3], pointRadius: 0, tension: .3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });

  // Returns chart — use prediction model data which has complete return %
  const retRows = pm.years.filter(y => y.annualReturnPct != null && y.actualSavings != null);
  const retLabels = retRows.map(y => y.year);
  const retData = retRows.map(y => y.annualReturnPct);
  charts.returns = new Chart($('chart-returns'), {
    type: 'bar',
    data: {
      labels: retLabels,
      datasets: [{ data: retData, backgroundColor: retData.map(v => v >= 0 ? C.green+'bb' : C.red+'bb'), borderRadius: 3 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: v => v+'%' } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${fmtPct(ctx.raw)}` } } },
    },
  });

  // Tax chart
  const salYears = DATA.salaries.filter(s => s.year >= 2016);
  charts.tax = new Chart($('chart-tax'), {
    type: 'bar',
    data: {
      labels: salYears.map(s => s.year),
      datasets: [
        { label: 'Net Income', data: salYears.map(s => (s.teddyGross + s.nicoleGross) - (s.teddyTax + s.nicoleTax)), backgroundColor: C.blue+'bb', borderRadius: 3 },
        { label: 'Tax', data: salYears.map(s => s.teddyTax + s.nicoleTax), backgroundColor: C.red+'bb', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });

  // Savings vs Earnings — built from salary data (2007+), with savings lookup
  const svsMap = {};
  for (const s of DATA.savingsVsSalaries) svsMap[s.year] = s.totalSavings;
  const allSal = DATA.salaries;
  let cumNet = 0;
  const cumNets = allSal.map(s => { cumNet += (s.teddyGross - s.teddyTax) + (s.nicoleGross - s.nicoleTax); return cumNet; });
  const savingsData = allSal.map(s => svsMap[s.year] || 0);

  charts.savingsEarnings = new Chart($('chart-savings-earnings'), {
    type: 'line',
    data: {
      labels: allSal.map(s => s.year),
      datasets: [
        { label: 'Total Savings', data: savingsData, borderColor: C.green, pointRadius: 3, tension: .3 },
        { label: 'Cumulative Net Earnings', data: cumNets, borderColor: C.blue, pointRadius: 3, tension: .3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });
}

// ── Year detail ─────────────────────────────────────────────

// ── Tax calculation from brackets ────────────────────────────

function calcTax(salary, brackets) {
  if (!brackets || !brackets.length) return 0;
  let tax = 0, prev = 0;
  for (const b of brackets) {
    if (salary <= prev) break;
    const taxable = Math.min(salary, b.upTo) - prev;
    tax += taxable * b.rate / 100;
    prev = b.upTo;
  }
  // Handle income above last bracket
  const lastBracket = brackets[brackets.length - 1];
  if (salary > lastBracket.upTo) {
    tax += (salary - lastBracket.upTo) * lastBracket.rate / 100;
  }
  return tax;
}

// ── Editable field helper ───────────────────────────────────

function editableField(year, path, value, opts = {}) {
  const id = `edit-${year}-${path.join('-')}`;
  const display = fmtFull(value);
  return `<input class="editable" id="${id}" data-year="${year}" data-path="${path.join('.')}" 
    value="${display}" title="Click to edit" 
    onfocus="this.value=this.dataset.raw||'${value}';this.select()" 
    onblur="saveField(this)" onkeydown="if(event.key==='Enter')this.blur()" 
    data-raw="${value}">`;
}

async function saveField(input) {
  const year = input.dataset.year;
  const path = input.dataset.path.split('.');
  const raw = parseFloat(input.value.replace(/[$,]/g, '')) || 0;
  input.dataset.raw = raw;
  input.value = fmtFull(raw);
  
  try {
    await fetch('/api/investments/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, path, value: raw }),
    });
    // Refresh data and re-render
    DATA = await fetchInvestments();
    const view = viewFromPath(location.pathname);
    showView(view);
  } catch (e) {
    console.error('Save failed:', e);
  }
}

async function saveSalaryField(input) {
  const idx = parseInt(input.dataset.idx);
  const field = input.dataset.field;
  const raw = parseFloat(input.value.replace(/[$,]/g, '')) || 0;
  input.dataset.raw = raw;
  input.value = fmtFull(raw);

  // Update local data — only store the editable field
  DATA.salaries[idx][field] = raw;

  try {
    await fetch('/api/investments/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DATA),
    });
    DATA = await fetchInvestments();
    showView('salaries');
  } catch (e) {
    console.error('Save failed:', e);
  }
}

// Make save functions global for inline handlers
window.saveField = saveField;
window.saveSalaryField = saveSalaryField;

function renderYear(el, year) {
  const d = DATA.years[year];
  if (!d) { el.innerHTML = '<p>No data for this year.</p>'; return; }
  const isCurrentYear = parseInt(year) === new Date().getFullYear();
  const liveBadge = isCurrentYear ? ' <span style="font-size:9px;background:rgba(159,202,86,0.2);color:var(--green);padding:2px 6px;border-radius:3px;letter-spacing:0.5px;vertical-align:middle">LIVE</span>' : '';

  // Tax refund = delta between tax at full salary vs tax at (salary - RRSP)
  // Using brackets for the delta calculation (credits cancel out in the difference)
  const brackets = d.taxBrackets || [];
  const teddyGross = d.salary.teddy.gross;
  const nicoleGross = d.salary.nicole.gross;
  const teddyRrsp = d.contributions.rrsp.teddy;
  const nicoleRrsp = d.contributions.rrsp.nicole;

  // Use stored tax values (which account for credits/deductions properly)
  const teddyTax = d.salary.teddy.actualTax;
  const nicoleTax = d.salary.nicole.actualTax;
  const teddyTaxRate = d.salary.teddy.actualTaxRate;
  const nicoleTaxRate = d.salary.nicole.actualTaxRate;

  // Tax refund from RRSP: computed as marginal delta (credits cancel out)
  const teddyRefund = calcTax(teddyGross, brackets) - calcTax(teddyGross - teddyRrsp, brackets);
  const nicoleRefund = calcTax(nicoleGross, brackets) - calcTax(nicoleGross - nicoleRrsp, brackets);

  const totalGross = teddyGross + nicoleGross;
  const totalTax = teddyTax + nicoleTax;
  const totalNet = totalGross - totalTax;
  const totalRefund = teddyRefund + nicoleRefund;

  const rrspProviders = Object.entries(d.accounts.rrsp);
  const tfsaProviders = Object.entries(d.accounts.tfsa);
  const debtEntries = Object.entries(d.debt).filter(([k]) => k !== 'totalDebt' && d.debt[k] !== 0);
  const hasWithdrawals = d.contributions.tfsaWithdrawals.teddy || d.contributions.tfsaWithdrawals.nicole;

  // Build other investments list
  const otherItems = [];
  if (d.accounts.nonRegistered) otherItems.push(['Non-registered', d.accounts.nonRegistered]);
  if (d.accounts.crypto) otherItems.push(['Crypto', d.accounts.crypto]);
  if (!d.accounts.nonRegistered && !d.accounts.crypto && d.accounts.privateInvesting) otherItems.push(['Private Investing', d.accounts.privateInvesting]);
  if (d.accounts.resp) otherItems.push(['RESP', d.accounts.resp]);

  el.innerHTML = `
    <div class="year-grid">
      <!-- Left: Income & Contributions -->
      <div class="yr-card">
        <h3>Income — ${year}</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Teddy</span><span class="pg-header">Nicole</span><span class="pg-header">Total</span>
          <span class="pg-label">Gross Salary</span>${editableField(year, ['salary','teddy','gross'], teddyGross)}${editableField(year, ['salary','nicole','gross'], nicoleGross)}<span class="pg-val">${fmtFull(totalGross)}</span>
          <span class="pg-label">Tax (${teddyTaxRate}% / ${nicoleTaxRate}%)</span><span class="pg-val neg">${fmtFull(teddyTax)}</span><span class="pg-val neg">${fmtFull(nicoleTax)}</span><span class="pg-val neg">${fmtFull(totalTax)}</span>
          <span class="pg-label pg-total">Net Income</span><span class="pg-val pg-total orange">${fmtFull(teddyGross - teddyTax)}</span><span class="pg-val pg-total orange">${fmtFull(nicoleGross - nicoleTax)}</span><span class="pg-val pg-total orange">${fmtFull(totalNet)}</span>
        </div>

        ${d.taxBrackets.length ? `
        <h3 class="section-gap">Tax Brackets</h3>
        <table class="salary-table" style="font-size:11px">
          <thead><tr><th>Up To</th><th>Rate</th><th>Tax</th><th>Cumulative</th></tr></thead>
          <tbody>
            ${d.taxBrackets.filter(b => b.tax > 0).map(b => `<tr><td>${fmtFull(b.upTo)}</td><td>${b.rate.toFixed(2)}%</td><td>${fmtFull(b.tax)}</td><td>${fmtFull(b.cumulative)}</td></tr>`).join('')}
          </tbody>
        </table>
        ` : ''}

        <h3 class="section-gap">Contributions</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Teddy</span><span class="pg-header">Nicole</span><span class="pg-header">Total</span>
          <span class="pg-label">RRSP</span>${editableField(year, ['contributions','rrsp','teddy'], d.contributions.rrsp.teddy)}${editableField(year, ['contributions','rrsp','nicole'], d.contributions.rrsp.nicole)}<span class="pg-val">${fmtFull(d.contributions.rrsp.teddy + d.contributions.rrsp.nicole)}</span>
          <span class="pg-label">Tax Refund (RRSP)</span><span class="pg-val pos">${fmtFull(teddyRefund)}</span><span class="pg-val pos">${fmtFull(nicoleRefund)}</span><span class="pg-val pos">${fmtFull(totalRefund)}</span>
          <span class="pg-label">TFSA</span>${editableField(year, ['contributions','tfsa','teddy'], d.contributions.tfsa.teddy)}${editableField(year, ['contributions','tfsa','nicole'], d.contributions.tfsa.nicole)}<span class="pg-val">${fmtFull(d.contributions.tfsa.teddy + d.contributions.tfsa.nicole)}</span>
          <span class="pg-label">TFSA Withdrawals</span>${editableField(year, ['contributions','tfsaWithdrawals','teddy'], d.contributions.tfsaWithdrawals.teddy)}${editableField(year, ['contributions','tfsaWithdrawals','nicole'], d.contributions.tfsaWithdrawals.nicole)}<span class="pg-val">${fmtFull(d.contributions.tfsaWithdrawals.teddy + d.contributions.tfsaWithdrawals.nicole)}</span>
          <span class="pg-label">RESP</span>${editableField(year, ['contributions','respContributions'], d.contributions.respContributions)}<span class="pg-val">—</span><span class="pg-val">${fmtFull(d.contributions.respContributions)}</span>
        </div>
      </div>

      <!-- Right: Returns + Portfolio -->
      <div class="yr-card">
        <h3>Returns${liveBadge}</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Start</span><span class="pg-header">Current</span><span class="pg-header">Return</span>
          ${d.returns.td.startingBalance ? `
            <span class="pg-label">TD</span><span class="pg-val">${fmt(d.returns.td.startingBalance)}</span><span class="pg-val">${fmt(d.returns.td.currentBalance)}</span><span class="pg-val ${valClass(d.returns.td.returnAmount)}">${fmtPct(d.returns.td.returnPct)}</span>
          ` : ''}
          ${d.returns.wealthsimple.totalStart ? `
            <span class="pg-label">Wealthsimple</span><span class="pg-val">${fmt(d.returns.wealthsimple.totalStart)}</span><span class="pg-val">${fmt(d.returns.wealthsimple.totalCurrent)}</span><span class="pg-val ${valClass(d.returns.wealthsimple.returnAmount)}">${fmtPct(d.returns.wealthsimple.returnPct)}</span>
          ` : ''}
          <span class="pg-label pg-total">Total</span><span class="pg-val pg-total">${fmt((d.returns.td.startingBalance||0) + (d.returns.wealthsimple.totalStart||0))}</span><span class="pg-val pg-total">${fmt(d.summary.total)}</span><span class="pg-val pg-total ${valClass(d.returns.total.returnAmount)}">${fmtFull(d.returns.total.returnAmount)} (${fmtPct(d.returns.total.returnPct)})</span>
        </div>
        ${d.returns.goal ? `
          <div class="data-row" style="margin-top:8px"><span class="dl">10% Goal</span><span class="dv">${fmtFull(d.returns.goal)}</span></div>
          <div class="data-row"><span class="dl">vs Goal</span><span class="dv ${valClass(d.returns.currentVsGoal)}">${fmtFull(d.returns.currentVsGoal)} (${fmtPct(d.returns.pctDifference)})</span></div>
        ` : ''}

        <h3 class="section-gap">Portfolio${liveBadge}</h3>
        ${d.accounts.allAccounts ? `
          ${(() => {
            const groups = { rrsp: [], tfsa: [], resp: [], cash: [], nonreg: [], crypto: [] };
            const labels = { rrsp: 'RRSP', tfsa: 'TFSA', resp: 'RESP', cash: 'Cash', nonreg: 'Non-registered', crypto: 'Crypto' };
            for (const a of d.accounts.allAccounts) groups[a.type]?.push(a) || (groups.cash = groups.cash || []).push(a);
            let html = '';
            for (const [type, accts] of Object.entries(groups)) {
              if (!accts.length) continue;
              const subtotal = accts.reduce((s, a) => s + a.balance, 0);
              html += `<div class="acct-section-label">${labels[type] || type}</div>`;
              html += accts.map(a => {
                const curLabel = a.currency !== 'cad' ? ' <small style="color:var(--muted)">' + a.currency.toUpperCase() + '</small>' : '';
                return `<div class="data-row"><span class="dl">${a.name} <span class="inst-tag">${a.institution}</span></span><span class="dv">${fmtFull(a.balance)}${curLabel}</span></div>`;
              }).join('');
              html += `<div class="data-row total"><span class="dl">${labels[type]} Total</span><span class="dv orange">${fmtFull(subtotal)}</span></div>`;
            }
            return html;
          })()}
        ` : `
          <div class="data-row"><span class="dl">TD Savings</span><span class="dv blue">${fmtFull(d.summary.tdSavings)}</span></div>
          <div class="data-row"><span class="dl">Wealthsimple</span><span class="dv blue">${fmtFull(d.summary.wealthsimple)}</span></div>
          ${d.summary.shopifyRsu ? `<div class="data-row"><span class="dl">Shopify RSU</span><span class="dv blue">${fmtFull(d.summary.shopifyRsu)}</span></div>` : ''}
        `}
        <div class="data-row total"><span class="dl">Total Investments</span><span class="dv blue">${fmtFull(d.summary.total)}</span></div>

        ${d.accounts.allLoans?.length ? `
          <h3 class="section-gap">Debt${liveBadge}</h3>
          ${d.accounts.allLoans.map(l => `<div class="data-row"><span class="dl">${l.name} <span class="inst-tag">${l.institution}</span></span><span class="dv neg">${fmtFull(l.balance)}</span></div>`).join('')}
          <div class="data-row total"><span class="dl">Total Debt</span><span class="dv neg">${fmtFull(d.debt.totalDebt)}</span></div>
        ` : debtEntries.length ? `
          ${debtEntries.map(([k, v]) => `<div class="data-row"><span class="dl">${k}</span><span class="dv neg">${fmtFull(v)}</span></div>`).join('')}
          <div class="data-row total"><span class="dl">Total Debt</span><span class="dv neg">${fmtFull(d.debt.totalDebt)}</span></div>
        ` : ''}
        <div class="data-row total"><span class="dl">Net Position</span><span class="dv ${valClass(d.subtotal)}">${fmtFull(d.subtotal)}</span></div>
      </div>

    </div>
  `;


}

// ── Salaries ────────────────────────────────────────────────

function renderSalaries(el) {
  const sal = DATA.salaries;
  const svs = DATA.savingsVsSalaries;
  const svsMap = {};
  for (const s of svs) svsMap[s.year] = s.totalSavings;
  // Compute totals from rows
  const tot = sal.reduce((acc, s) => ({
    teddyGross: acc.teddyGross + s.teddyGross, teddyTax: acc.teddyTax + s.teddyTax,
    nicoleGross: acc.nicoleGross + s.nicoleGross, nicoleTax: acc.nicoleTax + s.nicoleTax,
  }), { teddyGross:0, teddyTax:0, nicoleGross:0, nicoleTax:0 });
  const totNet = { teddyNet: tot.teddyGross - tot.teddyTax, nicoleNet: tot.nicoleGross - tot.nicoleTax };
  const totalGross = tot.teddyGross + tot.nicoleGross;
  const totalTax = tot.teddyTax + tot.nicoleTax;
  const totalNet = totalGross - totalTax;

  // Current year savings from latest year data
  const latestYear = Object.keys(DATA.years).sort((a,b) => b-a)[0];
  const totalSavings = DATA.years[latestYear]?.summary.total || 0;
  const savingsPct = totalGross ? (totalSavings / totalGross * 100) : 0;
  const savingsAfterTaxPct = totalNet ? (totalSavings / totalNet * 100) : 0;

  el.innerHTML = `
    <div class="overview-grid">
      <div class="ov-card full">
        <h3>Salary History</h3>
        <div class="chart-area"><canvas id="chart-salary"></canvas></div>
      </div>
      <div class="ov-card full">
        <h3>All Salaries</h3>
        <div style="overflow-x:auto">
          <table class="salary-table">
            <thead><tr>
              <th>Year</th><th>Teddy</th><th>Teddy Tax</th><th>Teddy Net</th>
              <th>Nicole</th><th>Nicole Tax</th><th>Nicole Net</th>
              <th>Total</th><th>Total Tax</th><th>Total Net</th>
              <th>Teddy YoY</th><th>Nicole YoY</th><th>Total YoY</th>
            </tr></thead>
            <tbody>
              ${sal.map((s, i) => {
                const prev = i > 0 ? sal[i-1] : null;
                const tNet = s.teddyGross - s.teddyTax;
                const nNet = s.nicoleGross - s.nicoleTax;
                const tGross = s.teddyGross + s.nicoleGross;
                const tTax = s.teddyTax + s.nicoleTax;
                const tNetTotal = tGross - tTax;
                const tYoY = prev && prev.teddyGross ? ((s.teddyGross - prev.teddyGross) / prev.teddyGross * 100) : 0;
                const nYoY = prev && prev.nicoleGross ? ((s.nicoleGross - prev.nicoleGross) / prev.nicoleGross * 100) : 0;
                const prevTotal = prev ? prev.teddyGross + prev.nicoleGross : 0;
                const totYoY = prevTotal ? ((tGross - prevTotal) / prevTotal * 100) : 0;
                return `<tr>
                <td>${s.year}</td>
                <td><input class="editable sal-edit" data-idx="${i}" data-field="teddyGross" value="${fmtFull(s.teddyGross)}" data-raw="${s.teddyGross}" onfocus="this.value=this.dataset.raw;this.select()" onblur="saveSalaryField(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td><input class="editable sal-edit" data-idx="${i}" data-field="teddyTax" value="${fmtFull(s.teddyTax)}" data-raw="${s.teddyTax}" onfocus="this.value=this.dataset.raw;this.select()" onblur="saveSalaryField(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td>${fmt(tNet)}</td>
                <td><input class="editable sal-edit" data-idx="${i}" data-field="nicoleGross" value="${fmtFull(s.nicoleGross)}" data-raw="${s.nicoleGross}" onfocus="this.value=this.dataset.raw;this.select()" onblur="saveSalaryField(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td><input class="editable sal-edit" data-idx="${i}" data-field="nicoleTax" value="${fmtFull(s.nicoleTax)}" data-raw="${s.nicoleTax}" onfocus="this.value=this.dataset.raw;this.select()" onblur="saveSalaryField(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td>${fmt(nNet)}</td>
                <td>${fmt(tGross)}</td><td>${fmt(tTax)}</td><td>${fmt(tNetTotal)}</td>
                <td class="${tYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(tYoY)}</td>
                <td class="${nYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(nYoY)}</td>
                <td class="${totYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(totYoY)}</td>
              </tr>`}).join('')}
            </tbody>
            <tfoot><tr style="font-weight:600;border-top:2px solid var(--border-lit)">
              <td>TOTAL</td><td>${fmt(tot.teddyGross)}</td><td>${fmt(tot.teddyTax)}</td><td>${fmt(totNet.teddyNet)}</td>
              <td>${fmt(tot.nicoleGross)}</td><td>${fmt(tot.nicoleTax)}</td><td>${fmt(totNet.nicoleNet)}</td>
              <td>${fmt(totalGross)}</td><td>${fmt(totalTax)}</td><td>${fmt(totalNet)}</td>
              <td>${fmt(totalSavings)}</td><td>${savingsPct.toFixed(1)}%</td><td>${savingsAfterTaxPct.toFixed(1)}%</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
      <div class="ov-card full">
        <h3>Savings vs Earnings</h3>
        <div style="overflow-x:auto">
          <table class="salary-table">
            <thead><tr><th>Year</th><th>Total Savings</th><th>Earnings (Pre-Tax)</th><th>Earnings (Post-Tax)</th><th>Avg Tax Rate</th></tr></thead>
            <tbody>
              ${sal.map(s => {
                const gross = s.teddyGross + s.nicoleGross;
                const tax = s.teddyTax + s.nicoleTax;
                const net = gross - tax;
                const rate = gross ? (tax / gross * 100) : 0;
                const savings = svsMap[s.year] || 0;
                return `<tr>
                <td>${s.year}</td><td>${fmt(savings)}</td><td>${fmt(gross)}</td><td>${fmt(net)}</td><td>${rate.toFixed(2)}%</td>
              </tr>`;
              }).join('')}
            </tbody>
            <tfoot><tr style="font-weight:600;border-top:2px solid var(--border-lit)">
              <td>TOTAL</td>
              <td>${fmt(totalSavings)}</td>
              <td>${fmt(totalGross)}</td>
              <td>${fmt(totalNet)}</td>
              <td>${totalGross ? (totalTax / totalGross * 100).toFixed(2) : 0}%</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  `;

  // Salary chart
  const recent = sal;
  charts.salary = new Chart($('chart-salary'), {
    type: 'bar',
    data: {
      labels: recent.map(s => s.year),
      datasets: [
        { label: 'Teddy Net', data: recent.map(s => s.teddyGross - s.teddyTax), backgroundColor: C.blue+'bb', borderRadius: 3 },
        { label: 'Nicole Net', data: recent.map(s => s.nicoleGross - s.nicoleTax), backgroundColor: C.purple+'bb', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } }, y: { stacked: true, ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });
}
