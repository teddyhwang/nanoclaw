/* ── NanoClaw Investment Dashboard ─────────────────────────── */

const C = {
  bg:'#151718', panel:'#1e2021', card:'#282a2b', border:'#2a3a40',
  muted:'#8a9da6', accent:'#43a5d5', text:'#d0d4d7', hi:'#eef0f2', max:'#ffffff',
  red:'#Cd3f45', orange:'#db7b55', yellow:'#e6cd69', green:'#9fca56',
  cyan:'#55dbbe', blue:'#55b5db', purple:'#a074c4', brown:'#8a553f',
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
}

// ── Overview ────────────────────────────────────────────────

function renderOverview(el) {
  const currentYear = Object.keys(DATA.years).sort((a,b) => b-a)[0];
  const cur = DATA.years[currentYear];
  const pm = DATA.predictionModel;

  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-item">
        <span class="stat-label">Total Savings</span>
        <span class="stat-value neutral">${fmt(cur.summary.total)}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">YTD Return</span>
        <span class="stat-value ${statClass(cur.returns.total.returnAmount)}">${fmt(cur.returns.total.returnAmount)}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">YTD Return %</span>
        <span class="stat-value ${statClass(cur.returns.total.returnPct)}">${fmtPct(cur.returns.total.returnPct)}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Total Debt</span>
        <span class="stat-value negative">${fmt(cur.debt.totalDebt)}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Net Worth (Investments)</span>
        <span class="stat-value ${statClass(cur.subtotal)}">${fmt(cur.subtotal)}</span>
      </div>
    </div>
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
        { label: 'Net Income', data: salYears.map(s => s.totalNet), backgroundColor: C.blue+'bb', borderRadius: 3 },
        { label: 'Tax', data: salYears.map(s => s.totalTax), backgroundColor: C.red+'bb', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });

  // Savings vs Earnings
  const svs = DATA.savingsVsSalaries;
  charts.savingsEarnings = new Chart($('chart-savings-earnings'), {
    type: 'line',
    data: {
      labels: svs.map(s => s.year),
      datasets: [
        { label: 'Total Savings', data: svs.map(s => s.totalSavings), borderColor: C.green, pointRadius: 3, tension: .3 },
        { label: 'Cumulative Net Earnings', data: (() => { let s=0; return svs.map(r => { s+=r.totalEarningsAfterTax; return s; }); })(), borderColor: C.blue, pointRadius: 3, tension: .3 },
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
// Make saveField global for inline handler
window.saveField = saveField;

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
          <span class="pg-label pg-total">Net Income</span><span class="pg-val pg-total pos">${fmtFull(teddyGross - teddyTax)}</span><span class="pg-val pg-total pos">${fmtFull(nicoleGross - nicoleTax)}</span><span class="pg-val pg-total pos">${fmtFull(totalNet)}</span>
        </div>

        <h3 style="margin-top:16px">Contributions</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Teddy</span><span class="pg-header">Nicole</span><span class="pg-header">Total</span>
          <span class="pg-label">RRSP</span>${editableField(year, ['contributions','rrsp','teddy'], d.contributions.rrsp.teddy)}${editableField(year, ['contributions','rrsp','nicole'], d.contributions.rrsp.nicole)}<span class="pg-val">${fmtFull(d.contributions.rrsp.teddy + d.contributions.rrsp.nicole)}</span>
          <span class="pg-label">Tax Refund (RRSP)</span><span class="pg-val pos">${fmtFull(teddyRefund)}</span><span class="pg-val pos">${fmtFull(nicoleRefund)}</span><span class="pg-val pos">${fmtFull(totalRefund)}</span>
          <span class="pg-label">TFSA</span>${editableField(year, ['contributions','tfsa','teddy'], d.contributions.tfsa.teddy)}${editableField(year, ['contributions','tfsa','nicole'], d.contributions.tfsa.nicole)}<span class="pg-val">${fmtFull(d.contributions.tfsa.teddy + d.contributions.tfsa.nicole)}</span>
          <span class="pg-label">TFSA Withdrawals</span>${editableField(year, ['contributions','tfsaWithdrawals','teddy'], d.contributions.tfsaWithdrawals.teddy)}${editableField(year, ['contributions','tfsaWithdrawals','nicole'], d.contributions.tfsaWithdrawals.nicole)}<span class="pg-val">${fmtFull(d.contributions.tfsaWithdrawals.teddy + d.contributions.tfsaWithdrawals.nicole)}</span>
          <span class="pg-label">RESP</span>${editableField(year, ['contributions','respContributions'], d.contributions.respContributions)}<span class="pg-val">—</span><span class="pg-val">${fmtFull(d.contributions.respContributions)}</span>
        </div>
      </div>

      <!-- Right: Portfolio Summary & Returns -->
      <div class="yr-card">
        <h3>Portfolio${liveBadge}</h3>
        <div class="data-row"><span class="dl">TD Savings</span><span class="dv blue">${fmtFull(d.summary.tdSavings)}</span></div>
        <div class="data-row"><span class="dl">Wealthsimple</span><span class="dv blue">${fmtFull(d.summary.wealthsimple)}</span></div>
        ${d.summary.shopifyRsu ? `<div class="data-row"><span class="dl">Shopify RSU</span><span class="dv blue">${fmtFull(d.summary.shopifyRsu)}</span></div>` : ''}
        <div class="data-row total"><span class="dl">Total Investments</span><span class="dv">${fmtFull(d.summary.total)}</span></div>
        ${debtEntries.length ? `
          ${debtEntries.map(([k, v]) => `<div class="data-row"><span class="dl">${k}</span><span class="dv neg">${fmtFull(v)}</span></div>`).join('')}
          <div class="data-row total"><span class="dl">Total Debt</span><span class="dv neg">${fmtFull(d.debt.totalDebt)}</span></div>
        ` : ''}
        <div class="data-row total"><span class="dl">Net Position</span><span class="dv ${valClass(d.subtotal)}">${fmtFull(d.subtotal)}</span></div>

        <h3 style="margin-top:16px">Returns${liveBadge}</h3>
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
      </div>

      <!-- RRSP Accounts -->
      <div class="yr-card">
        <h3>RRSP${liveBadge}</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Teddy</span><span class="pg-header">Nicole</span><span class="pg-header">Total</span>
          ${rrspProviders.map(([p, v]) => `
            <span class="pg-label">${p}</span><span class="pg-val">${fmtFull(v.teddy)}</span><span class="pg-val">${fmtFull(v.nicole)}</span><span class="pg-val">${fmtFull(v.teddy + v.nicole)}</span>
          `).join('')}
          <span class="pg-label pg-total">TOTAL</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalRrsp.teddy)}</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalRrsp.nicole)}</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalRrsp.total)}</span>
        </div>
      </div>

      <!-- TFSA + Other -->
      <div class="yr-card">
        <h3>TFSA${liveBadge}</h3>
        <div class="person-grid">
          <span></span><span class="pg-header">Teddy</span><span class="pg-header">Nicole</span><span class="pg-header">Total</span>
          ${tfsaProviders.map(([p, v]) => `
            <span class="pg-label">${p}</span><span class="pg-val">${fmtFull(v.teddy)}</span><span class="pg-val">${fmtFull(v.nicole)}</span><span class="pg-val">${fmtFull(v.teddy + v.nicole)}</span>
          `).join('')}
          ${hasWithdrawals ? `
            <span class="pg-label">Withdrawals</span><span class="pg-val neg">${fmtFull(d.contributions.tfsaWithdrawals.teddy)}</span><span class="pg-val neg">${fmtFull(d.contributions.tfsaWithdrawals.nicole)}</span><span class="pg-val neg">${fmtFull(d.contributions.tfsaWithdrawals.teddy + d.contributions.tfsaWithdrawals.nicole)}</span>
          ` : ''}
          <span class="pg-label pg-total">TOTAL</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalTfsa.teddy)}</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalTfsa.nicole)}</span><span class="pg-val pg-total">${fmtFull(d.accounts.totalTfsa.total)}</span>
        </div>
        ${otherItems.length ? `
          <h3 style="margin-top:16px">Other</h3>
          ${otherItems.map(([k, v]) => `<div class="data-row"><span class="dl">${k}</span><span class="dv">${fmtFull(v)}</span></div>`).join('')}
        ` : ''}
      </div>

      <!-- Tax Brackets -->
      ${d.taxBrackets.length ? `
      <div class="yr-card full">
        <h3>Tax Brackets — ${year}</h3>
        <table class="salary-table">
          <thead><tr><th>Up To</th><th>Rate</th><th>Tax</th><th>Cumulative</th></tr></thead>
          <tbody>
            ${d.taxBrackets.map(b => `<tr><td>${fmtFull(b.upTo)}</td><td>${b.rate.toFixed(2)}%</td><td>${fmtFull(b.tax)}</td><td>${fmtFull(b.cumulative)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
    </div>
  `;
}

// ── Salaries ────────────────────────────────────────────────

function renderSalaries(el) {
  const sal = DATA.salaries;
  const svs = DATA.savingsVsSalaries;
  // Compute totals from rows
  const tot = sal.reduce((acc, s) => ({
    teddyGross: acc.teddyGross + s.teddyGross, teddyTax: acc.teddyTax + s.teddyTax, teddyNet: acc.teddyNet + s.teddyNet,
    nicoleGross: acc.nicoleGross + s.nicoleGross, nicoleTax: acc.nicoleTax + s.nicoleTax, nicoleNet: acc.nicoleNet + s.nicoleNet,
    totalGross: acc.totalGross + s.totalGross, totalTax: acc.totalTax + s.totalTax, totalNet: acc.totalNet + s.totalNet,
  }), { teddyGross:0, teddyTax:0, teddyNet:0, nicoleGross:0, nicoleTax:0, nicoleNet:0, totalGross:0, totalTax:0, totalNet:0 });

  // Current year savings from latest year data
  const latestYear = Object.keys(DATA.years).sort((a,b) => b-a)[0];
  const totalSavings = DATA.years[latestYear]?.summary.total || 0;
  const savingsPct = tot.totalGross ? (totalSavings / tot.totalGross * 100) : 0;
  const savingsAfterTaxPct = tot.totalNet ? (totalSavings / tot.totalNet * 100) : 0;

  el.innerHTML = `
    <div class="stats-row" style="margin-bottom:16px">
      <div class="stat-item"><span class="stat-label">Lifetime Earnings</span><span class="stat-value neutral">${fmt(tot.totalGross)}</span></div>
      <div class="stat-item"><span class="stat-label">Lifetime Tax</span><span class="stat-value negative">${fmt(tot.totalTax)}</span></div>
      <div class="stat-item"><span class="stat-label">Lifetime Net</span><span class="stat-value positive">${fmt(tot.totalNet)}</span></div>
      <div class="stat-item"><span class="stat-label">Total Savings</span><span class="stat-value neutral">${fmt(totalSavings)}</span></div>
      <div class="stat-item"><span class="stat-label">Savings % of Gross</span><span class="stat-value neutral">${savingsPct.toFixed(1)}%</span></div>
      <div class="stat-item"><span class="stat-label">Savings % After Tax</span><span class="stat-value positive">${savingsAfterTaxPct.toFixed(1)}%</span></div>
    </div>
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
              ${sal.map(s => `<tr>
                <td>${s.year}</td><td>${fmt(s.teddyGross)}</td><td>${fmt(s.teddyTax)}</td><td>${fmt(s.teddyNet)}</td>
                <td>${fmt(s.nicoleGross)}</td><td>${fmt(s.nicoleTax)}</td><td>${fmt(s.nicoleNet)}</td>
                <td>${fmt(s.totalGross)}</td><td>${fmt(s.totalTax)}</td><td>${fmt(s.totalNet)}</td>
                <td class="${s.teddyYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(s.teddyYoY)}</td>
                <td class="${s.nicoleYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(s.nicoleYoY)}</td>
                <td class="${s.totalYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}">${fmtPct(s.totalYoY)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr style="font-weight:600;border-top:2px solid var(--border-lit)">
              <td>TOTAL</td><td>${fmt(tot.teddyGross)}</td><td>${fmt(tot.teddyTax)}</td><td>${fmt(tot.teddyNet)}</td>
              <td>${fmt(tot.nicoleGross)}</td><td>${fmt(tot.nicoleTax)}</td><td>${fmt(tot.nicoleNet)}</td>
              <td>${fmt(tot.totalGross)}</td><td>${fmt(tot.totalTax)}</td><td>${fmt(tot.totalNet)}</td>
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
              ${svs.map(s => `<tr>
                <td>${s.year}</td><td>${fmt(s.totalSavings)}</td><td>${fmt(s.totalEarningsBeforeTax)}</td><td>${fmt(s.totalEarningsAfterTax)}</td><td>${s.avgTaxRate.toFixed(2)}%</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr style="font-weight:600;border-top:2px solid var(--border-lit)">
              <td>TOTAL</td>
              <td>${fmt(totalSavings)}</td>
              <td>${fmt(svs.reduce((s,r) => s + r.totalEarningsBeforeTax, 0))}</td>
              <td>${fmt(svs.reduce((s,r) => s + r.totalEarningsAfterTax, 0))}</td>
              <td>${(svs.reduce((s,r) => s + r.avgTaxRate, 0) / svs.length).toFixed(2)}%</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  `;

  // Salary chart
  const recent = sal.filter(s => s.year >= 2015);
  charts.salary = new Chart($('chart-salary'), {
    type: 'bar',
    data: {
      labels: recent.map(s => s.year),
      datasets: [
        { label: 'Teddy Net', data: recent.map(s => s.teddyNet), backgroundColor: C.blue+'bb', borderRadius: 3 },
        { label: 'Nicole Net', data: recent.map(s => s.nicoleNet), backgroundColor: C.purple+'bb', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => fmt(v) } } },
      plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } } },
    },
  });
}
