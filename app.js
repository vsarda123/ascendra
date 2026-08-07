// Loaded up front via a plain <script> tag (see index.html) instead of
// being injected dynamically at runtime -- that pattern had real ordering
// edge cases where the injected script wouldn't reliably execute. This file
// just defines window.renderDashboard(); data.js calls it directly once it
// has data, a plain synchronous function call with no timing dependency.
function showFatalError(err) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#d0393f;color:#fff;' +
    'padding:14px 20px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;' +
    'max-height:60vh;overflow:auto;box-shadow:0 2px 12px rgba(0,0,0,0.3);';
  banner.textContent = 'Dashboard error (send this to Claude):\n' + (err && err.stack ? err.stack : String(err));
  document.body.prepend(banner);
}

window.renderDashboard = function (D) {
  try {
    runDashboard(D);
  } catch (err) {
    showFatalError(err);
  }
};

function runDashboard(D) {
  const { TODAY, EARLIEST, MATURITY_DAYS, DAILY_SPEND, LEADS } = D;

  // TEMP diagnostic -- always-visible, no DevTools needed. Shows exactly
  // what reached the renderer: which data path was used (live/mock,
  // supabase/live-fallback, per-source errors), row counts, real sample
  // values for campaign/audience/creative/landingPage, and how long each
  // stage actually took -- so "the page freezes" stops being a guess between
  // "still waiting on something async" (page stays interactive) and "a
  // synchronous computation is blocking the tab" (page stops responding to
  // clicks/scroll too), and becomes a measured number instead.
  let diagPanelEl = null;
  try {
    const uniq = (arr) => [...new Set(arr.filter(v => v != null))];
    const campaigns = uniq(DAILY_SPEND.map(r => r.campaign));
    const audiences = uniq(DAILY_SPEND.map(r => r.audience));
    const creatives = uniq(DAILY_SPEND.map(r => r.creative));
    const landingPages = uniq(DAILY_SPEND.map(r => r.landingPage));
    const info = window.DASHBOARD_SOURCE_INFO || {};
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#0B0E1F;color:#00E88F;padding:10px 16px;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;border-bottom:3px solid #7B00FF;position:relative;z-index:99998;';
    panel.textContent =
      'DIAG (send this to Claude)\n' +
      'mode=' + info.mode + '  dataSource=' + info.dataSource + '  sources=' + JSON.stringify(info.sources) + '\n' +
      'placeholders=' + JSON.stringify(info.placeholders) + '  timings=' + JSON.stringify(info.timings) + '\n' +
      'errors=' + JSON.stringify(info.errors) + (info.error ? '  topError=' + info.error : '') + '\n' +
      'DAILY_SPEND.length=' + DAILY_SPEND.length + '  LEADS.length=' + LEADS.length + '\n' +
      'campaigns(' + campaigns.length + ')=' + JSON.stringify(campaigns.slice(0, 3)) + '\n' +
      'audiences(' + audiences.length + ')=' + JSON.stringify(audiences.slice(0, 3)) + '\n' +
      'creatives(' + creatives.length + ')=' + JSON.stringify(creatives.slice(0, 3)) + '\n' +
      'landingPages(' + landingPages.length + ')=' + JSON.stringify(landingPages.slice(0, 3)) + '\n' +
      'sampleRow=' + JSON.stringify(DAILY_SPEND[0] || null);
    document.body.prepend(panel);
    diagPanelEl = panel;
  } catch (err) {
    showFatalError(err);
  }

  const state = { preset: 'last90', from: null, to: null, campaign: 'all', audience: 'all', creative: 'all', landingPage: 'all' };
  const sortState = { key: 'costPerSettlement', dir: 1 };

  // ---------------------------------------------------------------- helpers
  // Built from character codes, not typed literally, so this file is plain
  // ASCII end to end -- immune to any encoding mangling in a deploy/transport
  // pipeline that a literal em-dash or arrow character could suffer.
  const DASH = String.fromCharCode(8212); // em dash
  const DASH_EN = String.fromCharCode(8211); // en dash
  const MIDDOT = String.fromCharCode(183); // middle dot
  const UP_TRI = String.fromCharCode(9650); // up triangle
  const DOWN_TRI = String.fromCharCode(9660); // down triangle

  const fmtMoney = (n) => n == null || !isFinite(n) ? DASH : '$' + Math.round(n).toLocaleString();
  const fmtPct = (n, d = 1) => n == null || !isFinite(n) ? DASH : n.toFixed(d) + '%';
  const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekStartOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1) - day);
    return d.toISOString().slice(0, 10);
  }
  function clampDate(dateStr) {
    if (dateStr < EARLIEST) return EARLIEST;
    if (dateStr > TODAY) return TODAY;
    return dateStr;
  }
  function daysCount(from, to) {
    return Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  }
  function isMaturedDate(dateStr) {
    const daysAgo = Math.round((new Date(TODAY + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
    return daysAgo >= MATURITY_DAYS;
  }

  // ---------------------------------------------------------- date presets
  // Mirrors the standard Meta Ads Manager / Google Ads preset set, plus a
  // fully custom start/end range.
  function presetRange(preset) {
    switch (preset) {
      case 'today': return { from: TODAY, to: TODAY };
      case 'yesterday': { const y = addDaysStr(TODAY, -1); return { from: y, to: y }; }
      case 'last7': return { from: clampDate(addDaysStr(TODAY, -6)), to: TODAY };
      case 'last14': return { from: clampDate(addDaysStr(TODAY, -13)), to: TODAY };
      case 'last30': return { from: clampDate(addDaysStr(TODAY, -29)), to: TODAY };
      case 'thisweek': return { from: clampDate(weekStartOf(TODAY)), to: TODAY };
      case 'lastweek': {
        const thisWkStart = weekStartOf(TODAY);
        return { from: clampDate(addDaysStr(thisWkStart, -7)), to: clampDate(addDaysStr(thisWkStart, -1)) };
      }
      case 'thismonth': {
        const d = new Date(TODAY + 'T00:00:00');
        return { from: clampDate(new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)), to: TODAY };
      }
      case 'lastmonth': {
        const d = new Date(TODAY + 'T00:00:00');
        const lastMonthEnd = new Date(d.getFullYear(), d.getMonth(), 0);
        const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
        return { from: clampDate(lastMonthStart.toISOString().slice(0, 10)), to: clampDate(lastMonthEnd.toISOString().slice(0, 10)) };
      }
      case 'last90': return { from: clampDate(addDaysStr(TODAY, -89)), to: TODAY };
      case 'lifetime': return { from: EARLIEST, to: TODAY };
      default: return { from: clampDate(addDaysStr(TODAY, -89)), to: TODAY };
    }
  }

  function applyPreset(preset) {
    state.preset = preset;
    if (preset !== 'custom') {
      const r = presetRange(preset);
      state.from = r.from;
      state.to = r.to;
    }
  }

  // A row (spend or lead) matches the active campaign/audience/creative/
  // landing-page filters. These four all key off whatever strings are
  // actually present in the data -- there is no fixed campaign list.
  function rowMatchesFilters(row) {
    return (state.campaign === 'all' || row.campaign === state.campaign) &&
      (state.audience === 'all' || row.audience === state.audience) &&
      (state.creative === 'all' || row.creative === state.creative) &&
      (state.landingPage === 'all' || row.landingPage === state.landingPage);
  }
  function filtersAllOpen() {
    return state.campaign === 'all' && state.audience === 'all' && state.creative === 'all' && state.landingPage === 'all';
  }

  function leadsFor(from, to) {
    return LEADS.filter(l =>
      l.generatedDate >= from && l.generatedDate <= to &&
      (l.campaign === null ? filtersAllOpen() : rowMatchesFilters(l))
    );
  }
  function spendFor(from, to) {
    return DAILY_SPEND.filter(r => r.date >= from && r.date <= to && rowMatchesFilters(r));
  }

  // ------------------------------------------------------------- filter bar
  function uniqSorted(arr) { return [...new Set(arr.filter(v => v != null))].sort(); }

  function fillSelect(id, values, current) {
    const el = document.getElementById(id);
    el.innerHTML = '<option value="all">All</option>' + values.map(v =>
      `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`
    ).join('');
  }

  function updateRangeReadout() {
    document.getElementById('range-readout').textContent =
      state.from === state.to ? fmtDate(state.from) : `${fmtDate(state.from)} ${DASH_EN} ${fmtDate(state.to)}`;
  }

  function syncCustomInputs() {
    const wrap = document.getElementById('f-custom-wrap');
    wrap.style.display = state.preset === 'custom' ? 'flex' : 'none';
    document.getElementById('f-from').value = state.from;
    document.getElementById('f-to').value = state.to;
  }

  function initFilterBar() {
    // Options come straight off the live dataset -- whatever campaigns the
    // Meta API happens to have returned show up here automatically.
    fillSelect('f-campaign', uniqSorted(DAILY_SPEND.map(r => r.campaign)), state.campaign);
    fillSelect('f-audience', uniqSorted(DAILY_SPEND.map(r => r.audience)), state.audience);
    fillSelect('f-creative', uniqSorted(DAILY_SPEND.map(r => r.creative)), state.creative);
    fillSelect('f-landingpage', uniqSorted(DAILY_SPEND.map(r => r.landingPage)), state.landingPage);

    applyPreset(state.preset);

    const presetEl = document.getElementById('f-preset');
    presetEl.value = state.preset;
    const fromEl = document.getElementById('f-from');
    const toEl = document.getElementById('f-to');
    fromEl.min = toEl.min = EARLIEST;
    fromEl.max = toEl.max = TODAY;

    presetEl.addEventListener('change', (e) => {
      applyPreset(e.target.value);
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    });

    fromEl.addEventListener('change', () => {
      state.preset = 'custom';
      presetEl.value = 'custom';
      state.from = clampDate(fromEl.value || state.from);
      if (state.from > state.to) state.to = state.from;
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    });
    toEl.addEventListener('change', () => {
      state.preset = 'custom';
      presetEl.value = 'custom';
      state.to = clampDate(toEl.value || state.to);
      if (state.to < state.from) state.from = state.to;
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    });

    syncCustomInputs();
    updateRangeReadout();

    ['campaign', 'audience', 'creative', 'landingpage'].forEach(key => {
      const id = 'f-' + key;
      document.getElementById(id).addEventListener('change', (e) => {
        const stateKey = key === 'landingpage' ? 'landingPage' : key;
        state[stateKey] = e.target.value;
        renderAll();
      });
    });
    document.getElementById('reset-filters').addEventListener('click', () => {
      Object.assign(state, { preset: 'last90', campaign: 'all', audience: 'all', creative: 'all', landingPage: 'all' });
      initFilterBar();
      renderAll();
    });
  }

  // ------------------------------------------------------------------ KPIs
  function renderKpisMarketing() {
    const { from, to } = state;
    const rangeLen = daysCount(from, to);
    const prevTo = addDaysStr(from, -1);
    const prevFrom = addDaysStr(prevTo, -(rangeLen - 1));
    const prevAvailable = prevFrom >= EARLIEST;

    const curSpendRows = spendFor(from, to);
    const curLeads = leadsFor(from, to);
    const adSpend = curSpendRows.reduce((s, r) => s + r.spend, 0);
    const lpViews = curSpendRows.reduce((s, r) => s + r.landingPageViews, 0);
    const appts = curLeads.length;
    const convRate = lpViews ? (appts / lpViews) * 100 : null;
    const costPerAppt = appts ? adSpend / appts : null;

    let prevSpend = null, prevAppts = null;
    if (prevAvailable) {
      prevSpend = spendFor(prevFrom, prevTo).reduce((s, r) => s + r.spend, 0);
      prevAppts = leadsFor(prevFrom, prevTo).length;
    }

    const apptsDeltaPct = prevAppts ? ((appts - prevAppts) / prevAppts) * 100 : null;

    document.getElementById('kpi-marketing').innerHTML = `
      <div class="kpi">
        <div class="l">Ad Spend</div>
        <div class="v">${fmtMoney(adSpend)}</div>
        <div class="d">${prevSpend != null ? `vs ${fmtMoney(prevSpend)} previous period` : 'no earlier period available'}</div>
      </div>
      <div class="kpi">
        <div class="l">Landing Page Conv. Rate</div>
        <div class="v">${convRate != null ? convRate.toFixed(1) : DASH}<small>%</small></div>
        <div class="d">${appts} of ${lpViews.toLocaleString()} visits</div>
      </div>
      <div class="kpi">
        <div class="l">Appointments Booked</div>
        <div class="v">${appts}</div>
        <div class="d ${apptsDeltaPct > 0 ? 'good' : apptsDeltaPct < 0 ? 'bad' : ''}">${apptsDeltaPct != null ? (apptsDeltaPct >= 0 ? UP_TRI + ' ' : DOWN_TRI + ' ') + Math.abs(apptsDeltaPct).toFixed(0) + '% vs previous period' : DASH}</div>
      </div>
      <div class="kpi">
        <div class="l">Cost per Appointment</div>
        <div class="v">${fmtMoney(costPerAppt)}</div>
        <div class="d">target &lt; $150</div>
      </div>
    `;
    document.getElementById('marketing-week-note').textContent =
      `${fmtDate(from)} ${DASH_EN} ${fmtDate(to)} (${rangeLen} day${rangeLen === 1 ? '' : 's'})${prevAvailable ? ` ${MIDDOT} vs ${fmtDate(prevFrom)} ${DASH_EN} ${fmtDate(prevTo)}` : ''}`;
  }

  function mostRecentMaturedCohortWeek(from, to) {
    const weeksPresent = new Set(
      LEADS.filter(l => l.generatedDate >= from && l.generatedDate <= to).map(l => weekStartOf(l.generatedDate))
    );
    const matured = [...weeksPresent].filter(isMaturedDate).sort();
    return matured.length ? matured[matured.length - 1] : null;
  }

  function renderKpisJourney() {
    const cohortWeek = mostRecentMaturedCohortWeek(state.from, state.to);

    if (!cohortWeek) {
      document.getElementById('kpi-journey').innerHTML = `
        <div class="kpi" style="grid-column:1/-1"><div class="l">Customer journey</div>
        <div class="v" style="font-size:15px;color:var(--ink-3)">No cohort in the selected range has matured yet (needs ${MATURITY_DAYS}+ days). Widen the date range to see this block.</div></div>`;
      document.getElementById('journey-week-note').textContent = DASH;
      return;
    }

    const cohortLeads = LEADS.filter(l => weekStartOf(l.generatedDate) === cohortWeek && (l.campaign === null ? filtersAllOpen() : rowMatchesFilters(l)));
    const cohortSpend = DAILY_SPEND.filter(r => weekStartOf(r.date) === cohortWeek && rowMatchesFilters(r)).reduce((s, r) => s + r.spend, 0);
    const attended = cohortLeads.filter(l => l.attended).length;
    const optionsSent = cohortLeads.filter(l => l.optionsSent).length;
    const approved = cohortLeads.filter(l => l.approved).length;
    const settled = cohortLeads.filter(l => l.settled).length;
    const attendanceRate = cohortLeads.length ? (attended / cohortLeads.length) * 100 : null;
    const costPerSettlement = settled ? cohortSpend / settled : null;

    document.getElementById('kpi-journey').innerHTML = `
      <div class="kpi"><div class="l">Attendance Rate</div><div class="v">${attendanceRate != null ? attendanceRate.toFixed(0) : DASH}<small>%</small></div><div class="d">${attended} of ${cohortLeads.length} bookings</div></div>
      <div class="kpi"><div class="l">Options Sent</div><div class="v">${optionsSent}</div><div class="d">cohort: ${fmtDate(cohortWeek)}</div></div>
      <div class="kpi"><div class="l">Approvals</div><div class="v">${approved}</div><div class="d">cohort: ${fmtDate(cohortWeek)}</div></div>
      <div class="kpi"><div class="l">Settlements</div><div class="v">${settled}</div><div class="d">cohort: ${fmtDate(cohortWeek)}</div></div>
      <div class="kpi"><div class="l">Cost per Settlement</div><div class="v">${fmtMoney(costPerSettlement)}</div><div class="note">cohort spend basis, not same-week</div></div>
    `;
    document.getElementById('journey-week-note').textContent = `Cohort: leads generated week of ${fmtDate(cohortWeek)} ${DASH} fully matured`;
  }

  function renderUnattributed() {
    const allLeads = LEADS.filter(l => l.generatedDate >= state.from && l.generatedDate <= state.to);
    const unattr = allLeads.filter(l => l.campaign === null).length;
    const pct = allLeads.length ? (unattr / allLeads.length) * 100 : 0;
    document.getElementById('unattr-block').innerHTML =
      `<b>${fmtPct(pct)} unattributed</b> ${DASH} ${unattr} of ${allLeads.length} bookings in range arrived without a usable campaign source (broken UTM/match-key chain). Real cost, invisible in the table below.`;
  }

  // ---------------------------------------------------------------- funnel
  function renderFunnel() {
    const cohortWeek = mostRecentMaturedCohortWeek(state.from, state.to);

    if (!cohortWeek) {
      document.getElementById('funnel-block').innerHTML = `<p style="color:var(--ink-3);font-size:13px">No fully matured cohort in the selected range.</p>`;
      return;
    }

    const spendRows = DAILY_SPEND.filter(r => weekStartOf(r.date) === cohortWeek && rowMatchesFilters(r));
    const clicks = spendRows.reduce((s, r) => s + r.clicks, 0);
    const lpViews = spendRows.reduce((s, r) => s + r.landingPageViews, 0);
    const spend = spendRows.reduce((s, r) => s + r.spend, 0);
    const cohortLeads = LEADS.filter(l => weekStartOf(l.generatedDate) === cohortWeek && (l.campaign === null ? filtersAllOpen() : rowMatchesFilters(l)));
    const booked = cohortLeads.length;
    const attended = cohortLeads.filter(l => l.attended).length;
    const optionsSent = cohortLeads.filter(l => l.optionsSent).length;
    const approved = cohortLeads.filter(l => l.approved).length;
    const settled = cohortLeads.filter(l => l.settled).length;

    const stages = [
      { name: 'Ad Clicks', value: clicks, pctOf: null, meta: `${clicks ? '$' + (spend / clicks).toFixed(2) : DASH} / click` },
      { name: 'Landing Page Views', value: lpViews, pctOf: clicks, meta: null },
      { name: 'Appointments Booked', value: booked, pctOf: lpViews, meta: booked ? `$${(spend / booked).toFixed(0)}/appt` : null },
      { name: 'Appointment Attended', value: attended, pctOf: booked, meta: null },
      { name: 'Options Sent', value: optionsSent, pctOf: attended, meta: null },
      { name: 'Approved', value: approved, pctOf: optionsSent, meta: null },
      { name: 'Settled', value: settled, pctOf: approved, meta: settled ? `$${(spend / settled).toFixed(0)}/settlement` : null },
    ];
    const max = clicks || 1;
    const colors = ['#c9a8ff', '#b183ff', '#9a5eff', '#7B00FF', '#5f00cc', '#4a009e', '#350070'];

    document.getElementById('funnel-note').textContent = `Cohort: leads generated week of ${fmtDate(cohortWeek)} ${DASH} fully matured`;
    document.getElementById('funnel-block').innerHTML = `<div class="funnel">${stages.map((s, i) => {
      const widthPct = Math.max(4, (s.value / max) * 100);
      const pctLabel = s.pctOf ? `<b>${((s.value / s.pctOf) * 100).toFixed(0)}%</b> of prior &middot; ` : '';
      return `<div class="fstage">
        <span class="fname">${s.name}</span>
        <span class="fbarwrap"><span class="fbar" style="width:${widthPct}%;background:${colors[i]}">${s.value.toLocaleString()}</span></span>
        <span class="fmeta">${pctLabel}${s.meta || ''}</span>
      </div>`;
    }).join('')}</div>`;
  }

  // ----------------------------------------------------------------- trend
  function svgBars(values, { width = 320, height = 100, color }) {
    const max = Math.max(...values, 1);
    const n = values.length;
    const gap = n > 20 ? 1.5 : 6;
    const barW = (width - gap * (n - 1)) / n;
    const bars = values.map((v, i) => {
      const h = (v / max) * (height - 12);
      const x = i * (barW + gap);
      const y = height - h - 2;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barW, 0.5).toFixed(1)}" height="${h.toFixed(1)}" rx="${barW > 4 ? 2 : 0}" fill="${color}"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${bars}<line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="var(--hairline)" stroke-width="1"/></svg>`;
  }

  function svgLines(series, { width = 320, height = 100 }) {
    const allVals = series.flatMap(s => s.values);
    const max = Math.max(...allVals, 1);
    const n = series[0].values.length;
    const stepX = width / Math.max(1, n - 1);
    const scaleY = (v) => (height - 14) - (v / max) * (height - 20) + 4;

    const parts = series.map(s => {
      const solidIdx = s.dashedFrom != null ? s.dashedFrom : n;
      const pts = s.values.map((v, i) => `${(i * stepX).toFixed(1)},${scaleY(v).toFixed(1)}`);
      const solid = pts.slice(0, solidIdx + 1).join(' ');
      const dashed = pts.slice(Math.max(0, solidIdx)).join(' ');
      let out = '';
      if (solid) out += `<polyline points="${solid}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
      if (dashed && s.dashedFrom != null) out += `<polyline points="${dashed}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="3,3" opacity="0.55"/>`;
      const lastX = ((n - 1) * stepX).toFixed(1);
      const lastY = scaleY(s.values[n - 1]).toFixed(1);
      out += `<circle cx="${lastX}" cy="${lastY}" r="3" fill="${s.color}"/>`;
      return out;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${parts}<line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="var(--hairline)" stroke-width="1"/></svg>`;
  }

  // Buckets the selected range for the trend charts -- daily if the range
  // is 31 days or fewer (like Meta/Google Ads), otherwise weekly chunks so
  // a "Lifetime" or multi-month range doesn't render one bar per day.
  function bucketRange(from, to) {
    const len = daysCount(from, to);
    if (len <= 31) {
      const buckets = [];
      for (let i = 0; i < len; i++) {
        const d = addDaysStr(from, i);
        buckets.push({ start: d, end: d });
      }
      return buckets;
    }
    const buckets = [];
    let cursor = from;
    while (cursor <= to) {
      let end = addDaysStr(cursor, 6);
      if (end > to) end = to;
      buckets.push({ start: cursor, end });
      cursor = addDaysStr(end, 1);
    }
    return buckets;
  }

  function renderTrend() {
    const buckets = bucketRange(state.from, state.to);

    const spendByBucket = buckets.map(b => spendFor(b.start, b.end).reduce((s, r) => s + r.spend, 0));
    document.getElementById('trend-spend').innerHTML = svgBars(spendByBucket, { color: 'var(--cat-1)' });
    document.getElementById('trend-spend-legend').textContent =
      `Spend ($${Math.min(...spendByBucket).toLocaleString()}${DASH_EN}$${Math.max(...spendByBucket).toLocaleString()} per ${buckets.length > 31 ? 'week' : 'day'})`;

    const apptsByBucket = buckets.map(b => leadsFor(b.start, b.end).length);
    const settledByBucket = buckets.map(b => leadsFor(b.start, b.end).filter(l => l.settled).length);
    const firstImmatureIdx = buckets.findIndex(b => !isMaturedDate(b.end));
    document.getElementById('trend-funnel').innerHTML = svgLines([
      { values: apptsByBucket, color: 'var(--cat-1)', dashedFrom: firstImmatureIdx > 0 ? firstImmatureIdx - 1 : (firstImmatureIdx === 0 ? 0 : null) },
      { values: settledByBucket, color: 'var(--cat-2)', dashedFrom: firstImmatureIdx > 0 ? firstImmatureIdx - 1 : (firstImmatureIdx === 0 ? 0 : null) },
    ], {});
  }

  // ----------------------------------------------------------------- table
  function renderTable() {
    const { from, to } = state;
    const rangeSpend = spendFor(from, to);
    const rangeLeads = leadsFor(from, to);

    // Campaigns present in this range/filter combo -- read off the data,
    // not a fixed list. Audience/Creative/Landing Page shown are whatever
    // the first matching spend row for that campaign carries.
    const campaignNames = uniqSorted(rangeSpend.map(r => r.campaign));

    const rows = campaignNames.map(name => {
      const spendRows = rangeSpend.filter(r => r.campaign === name);
      const spend = spendRows.reduce((s, r) => s + r.spend, 0);
      const leads = rangeLeads.filter(l => l.campaign === name);
      const appts = leads.length;
      const anyMatured = leads.some(l => l.matured);
      const settled = leads.filter(l => l.settled).length;
      const costPerAppt = appts ? spend / appts : null;
      const costPerSettlement = settled ? spend / settled : null;
      let status = 'warning';
      if (!anyMatured) status = null;
      else if (costPerSettlement == null) status = 'critical';
      else if (costPerSettlement < 700) status = 'good';
      else if (costPerSettlement < 1500) status = 'warning';
      else status = 'critical';
      return {
        name, audience: spendRows[0].audience, creative: spendRows[0].creative, landingPage: spendRows[0].landingPage,
        spend, appts, costPerAppt, settled, costPerSettlement, status, anyMatured,
      };
    });

    rows.sort((a, b) => {
      const dir = sortState.dir;
      const key = sortState.key === 'campaign' ? 'name' : sortState.key;
      const av = a[key], bv = b[key];
      const an = av == null, bn = bv == null;
      if (an && bn) return 0;
      if (an) return 1; if (bn) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });

    document.getElementById('campaign-table-body').innerHTML = rows.map(r => `
      <tr>
        <td>${r.status ? `<span class="status-dot ${r.status}"></span>` : ''}${escapeHtml(r.name)}</td>
        <td class="dim">${escapeHtml(r.audience)}</td>
        <td class="dim">${escapeHtml(r.creative)}</td>
        <td class="dim">${escapeHtml(r.landingPage)}</td>
        <td>${fmtMoney(r.spend)}</td>
        <td>${r.appts}</td>
        <td>${fmtMoney(r.costPerAppt)}</td>
        <td>${r.anyMatured ? r.settled : '<span class="pending">maturing</span>'}</td>
        <td>${r.anyMatured ? fmtMoney(r.costPerSettlement) : `<span class="pending">${DASH}</span>`}</td>
      </tr>
    `).join('') || `<tr><td colspan="9" style="color:var(--ink-3);font-style:italic">No campaigns match the current filters.</td></tr>`;

    document.querySelectorAll('#campaign-table th[data-key]').forEach(th => {
      th.classList.toggle('sorted', th.dataset.key === sortState.key);
    });
  }

  function initTableSort() {
    document.querySelectorAll('#campaign-table th[data-key]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (sortState.key === key) sortState.dir *= -1;
        else { sortState.key = key; sortState.dir = 1; }
        renderTable();
      });
    });
  }

  // ------------------------------------------------------------------ init
  // Each section runs independently -- a bug in, say, the funnel shouldn't
  // also blank out the KPI tiles and table that would otherwise render fine.
  function renderAll() {
    const sections = [renderKpisMarketing, renderKpisJourney, renderUnattributed, renderFunnel, renderTrend, renderTable];
    for (const fn of sections) {
      try { fn(); } catch (err) { showFatalError(err); }
    }
  }

  try { initFilterBar(); } catch (err) { showFatalError(err); }
  try { initTableSort(); } catch (err) { showFatalError(err); }
  const renderStart = performance.now();
  renderAll();
  const renderMs = Math.round(performance.now() - renderStart);
  if (diagPanelEl) diagPanelEl.textContent += '\nrenderAll() took ' + renderMs + 'ms (synchronous -- anything here over ~200ms would visibly stall the tab)';
}
