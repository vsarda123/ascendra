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
  const OPTINS = D.OPTINS || [];
  const ATTRIBUTION = D.ATTRIBUTION || null;

  // This month's plan, entered by hand -- Meta has no concept of "our
  // monthly budget" or "our lead target", so there's nothing to read this
  // from. Kept here rather than threaded through the API/sync pipeline: it's
  // a display target, not data, and has no business sitting in the same path
  // as the Meta/ClickFunnels/Sheets join that's fragile enough already.
  // Update both at the start of each month.
  const MONTHLY_GOALS = { spendBudget: 4000, leadsTarget: 50 };

  const state = { preset: 'last90', from: null, to: null, campaign: 'all', audience: 'all', creative: 'all', landingPage: 'all' };
  // Highest spend first: with no settlement data to rank on, the money going
  // out is the thing worth looking at from the top of the table down.
  const sortState = { key: 'spend', dir: -1 };

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
  // timeZone:'UTC' so the day shown is the day in the data, not that instant
  // re-expressed in the viewer's zone (which would read a day early east of
  // Greenwich, the same trap the date helpers below hit).
  const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Every one of these parses with an explicit 'Z' and uses the getUTC*/
  // setUTC* accessors. Parsing as local time and then reading the result
  // back through toISOString() (which is UTC) silently shifts the date by a
  // day for anyone east of Greenwich: at UTC+10, local midnight is 14:00 UTC
  // the day before, so addDaysStr(d, 1) returned d unchanged. bucketRange()
  // advances its cursor with exactly that call, so its while loop never
  // terminated and locked up the tab.
  function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekStartOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1) - day);
    return d.toISOString().slice(0, 10);
  }
  function clampDate(dateStr) {
    if (dateStr < EARLIEST) return EARLIEST;
    if (dateStr > TODAY) return TODAY;
    return dateStr;
  }
  function daysCount(from, to) {
    return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  }
  function isMaturedDate(dateStr) {
    const daysAgo = Math.round((new Date(TODAY + 'T00:00:00Z') - new Date(dateStr + 'T00:00:00Z')) / 86400000);
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
        const d = new Date(TODAY + 'T00:00:00Z');
        const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        return { from: clampDate(first.toISOString().slice(0, 10)), to: TODAY };
      }
      case 'lastmonth': {
        const d = new Date(TODAY + 'T00:00:00Z');
        const lastMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
        const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
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
  function optinsFor(from, to) {
    return OPTINS.filter(o =>
      o.generatedDate >= from && o.generatedDate <= to &&
      (o.campaign === null ? filtersAllOpen() : rowMatchesFilters(o))
    );
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

    // Direct handler assignment, not addEventListener -- initFilterBar runs
    // again on the live-data re-render, and addEventListener would stack a
    // second copy of every handler onto the same surviving elements.
    presetEl.onchange = (e) => {
      applyPreset(e.target.value);
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    };

    fromEl.onchange = () => {
      state.preset = 'custom';
      presetEl.value = 'custom';
      state.from = clampDate(fromEl.value || state.from);
      if (state.from > state.to) state.to = state.from;
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    };
    toEl.onchange = () => {
      state.preset = 'custom';
      presetEl.value = 'custom';
      state.to = clampDate(toEl.value || state.to);
      if (state.to < state.from) state.from = state.to;
      syncCustomInputs();
      updateRangeReadout();
      renderAll();
    };

    syncCustomInputs();
    updateRangeReadout();

    ['campaign', 'audience', 'creative', 'landingpage'].forEach(key => {
      const id = 'f-' + key;
      document.getElementById(id).onchange = (e) => {
        const stateKey = key === 'landingpage' ? 'landingPage' : key;
        state[stateKey] = e.target.value;
        renderAll();
      };
    });
    document.getElementById('reset-filters').onclick = () => {
      Object.assign(state, { preset: 'last90', campaign: 'all', audience: 'all', creative: 'all', landingPage: 'all' });
      initFilterBar();
      renderAll();
    };
  }

  // ------------------------------------------------------------- pacing
  // Whole-account, calendar-month-to-date, deliberately ignoring the filter
  // bar above -- a $4,000 monthly budget or a 50-booking target means
  // nothing once sliced down to one campaign, so this reads DAILY_SPEND/
  // LEADS directly rather than through spendFor()/leadsFor().
  function daysInMonthOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  }
  function firstOfMonthOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  function renderMonthlyPacing() {
    const el = document.getElementById('pacing-grid');
    if (!el) return;

    const monthStart = firstOfMonthOf(TODAY);
    const daysElapsed = new Date(TODAY + 'T00:00:00Z').getUTCDate();
    const totalDays = daysInMonthOf(TODAY);
    const daysLeft = totalDays - daysElapsed;

    const spendMTD = DAILY_SPEND
      .filter(r => r.date >= monthStart && r.date <= TODAY)
      .reduce((s, r) => s + r.spend, 0);
    const bookingsMTD = LEADS.filter(l => l.generatedDate >= monthStart && l.generatedDate <= TODAY).length;

    // higherIsBetter: spend wants to land AT or UNDER goal; bookings want to
    // land AT or OVER goal. Same math, opposite "good" direction.
    function paceCard(label, actual, goal, fmt, higherIsBetter) {
      const pctActual = goal ? (actual / goal) * 100 : 0;
      const dailyPace = daysElapsed ? actual / daysElapsed : 0;
      const projected = dailyPace * totalDays;
      const pctProjected = goal ? (projected / goal) * 100 : 0;

      const status = higherIsBetter
        ? (pctProjected >= 100 ? 'good' : pctProjected >= 80 ? 'warning' : 'critical')
        : (pctProjected <= 100 ? 'good' : pctProjected <= 115 ? 'warning' : 'critical');
      const statusText = higherIsBetter
        ? { good: 'on pace to hit target', warning: 'tracking behind target', critical: 'well behind target' }[status]
        : { good: 'on pace, within budget', warning: 'tracking slightly over budget', critical: 'tracking well over budget' }[status];

      return `
        <div class="trend-card">
          <h5>${label}</h5>
          <div class="pace-value">${fmt(actual)} <span class="pace-of">of ${fmt(goal)}</span></div>
          <div class="pace-bar"><div class="pace-fill ${status}" style="width:${Math.min(100, pctActual).toFixed(1)}%"></div></div>
          <div class="pace-note"><span class="status-dot ${status}"></span>${statusText} ${MIDDOT} projected ${fmt(Math.round(projected))} by month end ${MIDDOT} ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</div>
        </div>`;
    }

    el.innerHTML =
      paceCard('Monthly Ad Spend', spendMTD, MONTHLY_GOALS.spendBudget, fmtMoney, false) +
      paceCard('Monthly Bookings', bookingsMTD, MONTHLY_GOALS.leadsTarget, (n) => n.toLocaleString(), true);

    document.getElementById('pacing-note').textContent =
      `${new Date(TODAY + 'T00:00:00Z').toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })} to date `
      + `(day ${daysElapsed} of ${totalDays}) ${MIDDOT} whole account, not affected by the filters above`;

    // Day-by-day trajectory against an ideal straight-line pace, not just
    // the single end-of-month projection above -- this is what actually
    // shows whether a slow start is catching up or falling further behind.
    // Only plotted through today: extending the actual line into days that
    // haven't happened yet would mean inventing them.
    const daysList = Array.from({ length: daysElapsed }, (_, i) => addDaysStr(monthStart, i));
    const spendByDate = {};
    for (const r of DAILY_SPEND) spendByDate[r.date] = (spendByDate[r.date] || 0) + r.spend;
    const bookingsByDate = {};
    for (const l of LEADS) bookingsByDate[l.generatedDate] = (bookingsByDate[l.generatedDate] || 0) + 1;

    let runningSpend = 0;
    const spendCum = daysList.map(d => { runningSpend += (spendByDate[d] || 0); return runningSpend; });
    let runningBookings = 0;
    const bookingsCum = daysList.map(d => { runningBookings += (bookingsByDate[d] || 0); return runningBookings; });

    const spendPace = daysList.map((_, i) => (MONTHLY_GOALS.spendBudget / totalDays) * (i + 1));
    const bookingsPace = daysList.map((_, i) => (MONTHLY_GOALS.leadsTarget / totalDays) * (i + 1));
    const fmtMoneyShortPace = (n) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmtMoney(n);

    document.getElementById('pace-trend-spend').innerHTML = svgLines(
      [
        { values: spendCum, color: 'var(--cat-1)', tooltips: daysList.map((d, i) => `${fmtDate(d)}: ${fmtMoney(spendCum[i])} spent`) },
        { values: spendPace, color: 'var(--ink-3)', dashedFrom: 0, tooltips: daysList.map((d, i) => `${fmtDate(d)}: ${fmtMoney(spendPace[i])} pace`) },
      ],
      { dates: daysList, valueFmt: fmtMoneyShortPace }
    );
    document.getElementById('pace-trend-leads').innerHTML = svgLines(
      [
        { values: bookingsCum, color: 'var(--cat-4)', tooltips: daysList.map((d, i) => `${fmtDate(d)}: ${bookingsCum[i]} booked`) },
        { values: bookingsPace, color: 'var(--ink-3)', dashedFrom: 0, tooltips: daysList.map((d, i) => `${fmtDate(d)}: ${bookingsPace[i].toFixed(1)} pace`) },
      ],
      { dates: daysList, valueFmt: (v) => Math.round(v).toString() }
    );

    // Cost per lead is undefined until the first booking of the month lands
    // -- trimmed to start there rather than showing a divide-by-zero as $0.
    const firstBookingIdx = bookingsCum.findIndex(v => v > 0);
    const cplEl = document.getElementById('pace-trend-cpl');
    if (firstBookingIdx === -1) {
      cplEl.innerHTML = `<p style="color:var(--ink-3);font-style:italic;margin:8px 0">No bookings recorded yet this month.</p>`;
    } else {
      const cplDates = daysList.slice(firstBookingIdx);
      const cplActual = cplDates.map((_, i) => spendCum[firstBookingIdx + i] / bookingsCum[firstBookingIdx + i]);
      const cplTarget = MONTHLY_GOALS.spendBudget / MONTHLY_GOALS.leadsTarget;
      cplEl.innerHTML = svgLines(
        [
          { values: cplActual, color: 'var(--cat-2)', tooltips: cplDates.map((d, i) => `${fmtDate(d)}: ${fmtMoney(cplActual[i])}/lead`) },
          { values: cplDates.map(() => cplTarget), color: 'var(--ink-3)', dashedFrom: 0, tooltips: cplDates.map(() => `${fmtMoney(cplTarget)}/lead target`) },
        ],
        { dates: cplDates, valueFmt: (v) => '$' + v.toFixed(0) }
      );
    }
  }

  // ------------------------------------------------------------------ KPIs
  function renderKpisMarketing() {
    const { from, to } = state;
    const rangeLen = daysCount(from, to);
    const prevTo = addDaysStr(from, -1);
    const prevFrom = addDaysStr(prevTo, -(rangeLen - 1));
    const prevAvailable = prevFrom >= EARLIEST;

    const curSpendRows = spendFor(from, to);
    const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

    const adSpend = sum(curSpendRows, 'spend');
    const impressions = sum(curSpendRows, 'impressions');
    const reach = sum(curSpendRows, 'reach');
    // Link clicks, not the raw `clicks` total -- `clicks` counts every click
    // anywhere on the ad, including likes, comments and profile taps, so it
    // overstates how many people actually set off toward the site.
    const linkClicks = sum(curSpendRows, 'inlineLinkClicks');
    const outbound = sum(curSpendRows, 'outboundClicks');
    const videoPlays = sum(curSpendRows, 'videoPlays');

    const ctr = impressions ? (linkClicks / impressions) * 100 : null;
    const cpc = linkClicks ? adSpend / linkClicks : null;
    const cpm = impressions ? (adSpend / impressions) * 1000 : null;
    const frequency = reach ? impressions / reach : null;
    const hookRate = impressions ? (videoPlays / impressions) * 100 : null;
    // How many of the people who clicked in Meta actually left for the site.
    const clickThrough = linkClicks ? (outbound / linkClicks) * 100 : null;

    const prevSpend = prevAvailable ? sum(spendFor(prevFrom, prevTo), 'spend') : null;
    const spendDeltaPct = prevSpend ? ((adSpend - prevSpend) / prevSpend) * 100 : null;

    document.getElementById('kpi-marketing').innerHTML = `
      <div class="kpi">
        <div class="l">Ad Spend</div>
        <div class="v">${fmtMoney(adSpend)}</div>
        <div class="d ${spendDeltaPct > 0 ? 'bad' : spendDeltaPct < 0 ? 'good' : ''}">${prevSpend != null ? (spendDeltaPct >= 0 ? UP_TRI + ' ' : DOWN_TRI + ' ') + Math.abs(spendDeltaPct).toFixed(0) + `% vs ${fmtMoney(prevSpend)} prior` : 'no earlier period available'}</div>
      </div>
      <div class="kpi">
        <div class="l">Impressions</div>
        <div class="v">${impressions.toLocaleString()}</div>
        <div class="d">${reach ? `${reach.toLocaleString()} reached ${MIDDOT} ${frequency.toFixed(1)}x frequency` : 'reach not reported'}</div>
      </div>
      <div class="kpi">
        <div class="l">Link CTR</div>
        <div class="v">${ctr != null ? ctr.toFixed(2) : DASH}<small>%</small></div>
        <div class="d">${linkClicks.toLocaleString()} link clicks</div>
      </div>
      <div class="kpi">
        <div class="l">Cost per Link Click</div>
        <div class="v">${cpc != null ? '$' + cpc.toFixed(2) : DASH}</div>
        <div class="d">${cpm != null ? '$' + cpm.toFixed(2) + ' CPM' : DASH}</div>
      </div>
      <div class="kpi">
        <div class="l">Hook Rate</div>
        <div class="v">${hookRate != null && videoPlays ? hookRate.toFixed(1) : DASH}<small>%</small></div>
        <div class="d">${videoPlays ? videoPlays.toLocaleString() + ' 3-sec plays' : 'no video ads in range'}</div>
      </div>
      <div class="kpi">
        <div class="l">Click ${DASH_EN} Site Follow-through</div>
        <div class="v">${clickThrough != null && outbound ? clickThrough.toFixed(0) : DASH}<small>%</small></div>
        <div class="d">${outbound ? outbound.toLocaleString() + ' left Meta for the site' : 'outbound clicks not reported'}</div>
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

  // Downloads and bookings are deliberately separate numbers. A guide
  // download is not a lead; cost per lead divides spend by booked meetings,
  // which is a far smaller denominator and a far higher, truer figure.
  function renderKpisJourney() {
    const { from, to } = state;
    const grid = document.getElementById('kpi-journey');

    if (OPTINS.length === 0 && LEADS.length === 0) {
      grid.innerHTML = `
        <div class="kpi" style="grid-column:1/-1"><div class="l">Customer journey</div>
        <div class="v" style="font-size:15px;color:var(--ink-3);line-height:1.5">No opt-in or booking data has synced yet, so nothing past the ad click can be measured.</div></div>`;
      document.getElementById('journey-week-note').textContent = `Ad-side metrics above are live from Meta ${DASH} this block fills in once the sync runs`;
      return;
    }

    const spend = spendFor(from, to).reduce((s, r) => s + r.spend, 0);
    const downloads = optinsFor(from, to).length;
    const bookings = leadsFor(from, to);
    const booked = bookings.length;

    const costPerDownload = downloads ? spend / downloads : null;
    const costPerLead = booked ? spend / booked : null;
    const downloadToBooking = downloads ? (booked / downloads) * 100 : null;

    // Attendance is only meaningful over bookings where someone actually
    // recorded an outcome. Dividing by all bookings would read every blank
    // cell as a no-show.
    const withOutcome = bookings.filter(b => b.attendanceRecorded);
    const attended = withOutcome.filter(b => b.attended).length;
    const attendanceRate = withOutcome.length ? (attended / withOutcome.length) * 100 : null;

    grid.innerHTML = `
      <div class="kpi">
        <div class="l">Guide Downloads</div>
        <div class="v">${downloads.toLocaleString()}</div>
        <div class="d">${costPerDownload != null ? fmtMoney(costPerDownload) + ' each' : 'no spend in range'}</div>
      </div>
      <div class="kpi">
        <div class="l">Qualified Leads (booked)</div>
        <div class="v">${booked.toLocaleString()}</div>
        <div class="d">meetings booked, not downloads</div>
      </div>
      <div class="kpi">
        <div class="l">Download ${DASH_EN} Booking</div>
        <div class="v">${downloadToBooking != null ? downloadToBooking.toFixed(1) : DASH}<small>%</small></div>
        <div class="d">${downloads ? `${booked} of ${downloads.toLocaleString()} downloads booked` : DASH}</div>
      </div>
      <div class="kpi">
        <div class="l">Cost per Qualified Lead</div>
        <div class="v">${fmtMoney(costPerLead)}</div>
        <div class="note">spend / booked meetings</div>
      </div>
      <div class="kpi">
        <div class="l">Attendance Rate</div>
        <div class="v">${attendanceRate != null ? attendanceRate.toFixed(0) : DASH}<small>%</small></div>
        <div class="d">${withOutcome.length
          ? `${attended} of ${withOutcome.length} with an outcome recorded`
          : 'no attendance recorded on any booking'}</div>
      </div>
    `;

    const unattributed = ATTRIBUTION ? ATTRIBUTION.bookings - ATTRIBUTION.bookingsAttributed : null;
    document.getElementById('journey-week-note').textContent =
      `${fmtDate(from)} ${DASH_EN} ${fmtDate(to)}`
      + (unattributed ? ` ${MIDDOT} ${unattributed} of ${ATTRIBUTION.bookings} bookings carry no campaign, so cost per lead counts spend against the attributed ones only` : '');
  }

  function renderUnattributed() {
    const block = document.getElementById('unattr-block');
    const allLeads = LEADS.filter(l => l.generatedDate >= state.from && l.generatedDate <= state.to);
    // With no leads at all there is no attribution gap to report -- showing
    // "0 of 0 bookings" would read as a clean result rather than no data.
    if (allLeads.length === 0) { block.style.display = 'none'; return; }
    block.style.display = '';
    // Split by how the booking arrived. An organic booking has no campaign
    // because no ad produced it, which is not a tagging failure -- lumping
    // the two together makes the tagging look far worse than it is and hides
    // how much of the pipeline is unpaid.
    const organic = allLeads.filter(l => l.channel === 'organic').length;
    const lostTags = allLeads.filter(l => l.channel === 'paid-unattributed' || (l.channel === 'unknown' && !l.campaign)).length;
    if (organic === 0 && lostTags === 0) { block.style.display = 'none'; return; }

    const parts = [];
    if (lostTags) {
      parts.push(`<b>${fmtPct((lostTags / allLeads.length) * 100)} of bookings lost their campaign tags</b> ${DASH} `
        + `${lostTags} of ${allLeads.length} came from an ad but do not say which. Their spend is counted, they are not, `
        + `so per-campaign cost per lead reads higher than the truth.`);
    }
    if (organic) {
      parts.push(`${organic} booking${organic === 1 ? '' : 's'} came from unpaid sources (email, Linktree, referral) ${DASH} `
        + `no campaign because no ad was involved.`);
    }
    block.innerHTML = parts.join('<br>');
  }

  // ---------------------------------------------------------------- funnel
  // The whole selected range, not one matured cohort week. The ad-side
  // stages are same-day facts that need no maturation, and restricting the
  // entire funnel to a single week threw away most of the range and showed
  // nothing at all whenever no week had matured yet.
  function renderFunnel() {
    const { from, to } = state;
    const spendRows = spendFor(from, to);
    const sum = (key) => spendRows.reduce((s, r) => s + (r[key] || 0), 0);

    const spend = sum('spend');
    const impressions = sum('impressions');
    const videoPlays = sum('videoPlays');
    const linkClicks = sum('inlineLinkClicks');
    const outbound = sum('outboundClicks');
    const lpViews = sum('landingPageViews');

    const rangeLeads = leadsFor(from, to);
    const booked = rangeLeads.length;
    const downloads = optinsFor(from, to).length;
    const withOutcome = rangeLeads.filter(l => l.attendanceRecorded);
    const attended = withOutcome.filter(l => l.attended).length;

    const costPer = (n) => n ? '$' + (spend / n).toFixed(n < 100 ? 0 : 2) + ' each' : null;
    const optinsConnected = OPTINS.length > 0;
    const bookingsConnected = LEADS.length > 0;
    const pagesConnected = lpViews > 0;

    // `source` is what makes an empty stage readable: a real zero from a
    // connected source means the step is genuinely losing everyone, while an
    // unconnected source means we simply cannot see that step yet. Those
    // demand opposite responses, so the funnel must not render them alike.
    const stages = [
      { name: 'Impressions', value: impressions, pctOf: null, meta: costPer(impressions / 1000) ? '$' + ((spend / impressions) * 1000).toFixed(2) + ' CPM' : null, source: true },
      { name: '3-Sec Video Plays', value: videoPlays, pctOf: impressions, meta: videoPlays ? 'hook rate' : 'no video ads in range', source: videoPlays > 0 },
      { name: 'Link Clicks', value: linkClicks, pctOf: impressions, meta: costPer(linkClicks), source: true },
      { name: 'Left Meta for Site', value: outbound, pctOf: linkClicks, meta: costPer(outbound), source: outbound > 0 },
      { name: 'Landing Page Views', value: lpViews, pctOf: outbound || linkClicks, meta: pagesConnected ? costPer(lpViews) : 'ClickFunnels not mapped', source: pagesConnected },
      { name: 'Guide Downloads', value: downloads, pctOf: lpViews || outbound || linkClicks, meta: optinsConnected ? costPer(downloads) : 'opt-in sheet not synced', source: optinsConnected },
      { name: 'Meetings Booked', value: booked, pctOf: downloads || lpViews || outbound, meta: bookingsConnected ? costPer(booked) : 'booking sheet not synced', source: bookingsConnected },
      {
        name: 'Meeting Attended',
        value: attended,
        pctOf: withOutcome.length || null,
        // Measured only over bookings with an outcome recorded. Against all
        // bookings this would read near zero, because the column is blank
        // on nearly every row rather than because nobody showed up.
        meta: withOutcome.length ? `of ${withOutcome.length} with an outcome recorded` : 'attendance not filled in on any booking',
        source: withOutcome.length > 0,
      },
    ];

    const max = impressions || 1;
    const colors = ['#d9c2ff', '#c9a8ff', '#b183ff', '#9a5eff', '#7B00FF', '#6a00e0', '#5f00cc', '#4a009e', '#3d0082', '#350070'];

    document.getElementById('funnel-note').textContent =
      `${fmtDate(from)} ${DASH_EN} ${fmtDate(to)} ${MIDDOT} each bar shows what share of the step above it survived`;

    document.getElementById('funnel-block').innerHTML = `<div class="funnel">${stages.map((s, i) => {
      if (!s.source) {
        return `<div class="fstage">
          <span class="fname">${s.name}</span>
          <span class="fbarwrap"><span class="fbar unavailable">not connected</span></span>
          <span class="fmeta">${s.meta || ''}</span>
        </div>`;
      }
      const widthPct = Math.max(4, (s.value / max) * 100);
      const dropPct = s.pctOf ? (s.value / s.pctOf) * 100 : null;
      const dropClass = dropPct == null ? '' : dropPct < 25 ? ' bad' : dropPct < 60 ? ' warn' : ' ok';
      const pctLabel = dropPct != null ? `<b class="drop${dropClass}">${dropPct.toFixed(dropPct < 10 ? 1 : 0)}%</b> of prior ${MIDDOT} ` : '';
      return `<div class="fstage">
        <span class="fname">${s.name}</span>
        <span class="fbarwrap"><span class="fbar" style="width:${widthPct}%;background:${colors[i]}">${s.value.toLocaleString()}</span></span>
        <span class="fmeta">${pctLabel}${s.meta || ''}</span>
      </div>`;
    }).join('')}</div>`;
  }

  // ------------------------------------------------------------ campaign spend
  // Which campaigns are actually driving the cost, ranked highest-spend
  // first, plus a plain-language flag for the ones spending real money
  // without producing bookings -- the same 'critical' threshold (>=$400/lead)
  // already used to colour the campaign table below, so a campaign doesn't
  // read as fine here and flagged there.
  function renderCampaignSpend() {
    const { from, to } = state;
    const rows = spendFor(from, to);
    const rangeLeads = leadsFor(from, to);
    const noBookings = LEADS.length === 0;

    const byCampaign = {};
    for (const r of rows) {
      if (!byCampaign[r.campaign]) byCampaign[r.campaign] = 0;
      byCampaign[r.campaign] += r.spend;
    }
    const entries = Object.keys(byCampaign).map(name => {
      const spend = byCampaign[name];
      const bookings = rangeLeads.filter(l => l.campaign === name).length;
      const costPerLead = bookings ? spend / bookings : null;
      return { name, spend, bookings, costPerLead };
    }).sort((a, b) => b.spend - a.spend);

    const max = entries.length ? entries[0].spend : 1;
    const shown = entries.slice(0, 10);

    document.getElementById('campaign-spend-note').textContent =
      `${fmtDate(from)} ${DASH_EN} ${fmtDate(to)} ${MIDDOT} ranked by spend`
      + (entries.length > shown.length ? ` ${MIDDOT} top ${shown.length} of ${entries.length} campaigns shown` : '');

    document.getElementById('campaign-spend-block').innerHTML = shown.length
      ? `<div class="funnel">${shown.map(e => {
          const widthPct = Math.max(4, (e.spend / max) * 100);
          let dotClass = '';
          if (!noBookings) dotClass = e.costPerLead == null ? 'critical' : e.costPerLead < 150 ? 'good' : e.costPerLead < 400 ? 'warning' : 'critical';
          const meta = noBookings ? `${e.bookings} booked` : e.costPerLead != null ? `${fmtMoney(e.costPerLead)}/lead ${MIDDOT} ${e.bookings} booked` : 'no bookings yet';
          return `<div class="fstage">
            <span class="fname">${dotClass ? `<span class="status-dot ${dotClass}"></span>` : ''}${escapeHtml(e.name)}</span>
            <span class="fbarwrap"><span class="fbar" style="width:${widthPct}%;background:var(--cat-1)">${fmtMoney(e.spend)}</span></span>
            <span class="fmeta">${meta}</span>
          </div>`;
        }).join('')}</div>`
      : `<p style="color:var(--ink-3);font-style:italic;margin:0">No spend in the selected range/filters.</p>`;

    const block = document.getElementById('campaign-opportunities');
    if (noBookings) { block.style.display = 'none'; return; }
    const flagged = entries.filter(e => e.spend >= 50 && (e.costPerLead == null || e.costPerLead >= 400));
    if (!flagged.length) {
      block.style.display = 'none';
    } else {
      block.style.display = '';
      block.innerHTML = `<b>${flagged.length} campaign${flagged.length === 1 ? '' : 's'} worth a look:</b><br>` +
        flagged.slice(0, 5).map(e => e.costPerLead == null
          ? `${escapeHtml(e.name)} ${DASH} ${fmtMoney(e.spend)} spent with no bookings recorded in this range`
          : `${escapeHtml(e.name)} ${DASH} ${fmtMoney(e.costPerLead)} per lead, well above the rest`
        ).join('<br>');
    }
  }

  // --------------------------------------------------------- booking heatmap
  // Day-of-week x hour-of-day grid of when bookings actually land. Hour comes
  // from generatedHour, read straight off the sheet's timestamp cell by
  // lib/sources.js -- null on any booking recorded before that column
  // existed, or where the sheet only ever held a date. Those are counted and
  // disclosed, not silently dropped into an hour they weren't seen at.
  function renderBookingHeatmap() {
    const el = document.getElementById('heatmap-block');
    if (!el) return;
    const { from, to } = state;

    if (LEADS.length === 0) {
      el.innerHTML = `<p style="color:var(--ink-3);font-style:italic;margin:0">Booking sheet not synced yet.</p>`;
      document.getElementById('heatmap-note').textContent = '';
      return;
    }

    const rows = leadsFor(from, to);
    const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let withHour = 0, withoutHour = 0;
    for (const l of rows) {
      if (l.generatedHour == null) { withoutHour++; continue; }
      withHour++;
      const dow = (new Date(l.generatedDate + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0..Sun=6
      grid[dow][l.generatedHour]++;
    }

    document.getElementById('heatmap-note').textContent =
      `${fmtDate(from)} ${DASH_EN} ${fmtDate(to)} ${MIDDOT} ${withHour} booking${withHour === 1 ? '' : 's'} with a recorded time`
      + (withoutHour ? ` ${MIDDOT} ${withoutHour} without one, excluded from the grid` : '');

    if (withHour === 0) {
      el.innerHTML = `<p style="color:var(--ink-3);font-style:italic;margin:0">No bookings in this range have a recorded time yet.</p>`;
      return;
    }

    let max = 0, peakDow = 0, peakHour = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (grid[d][h] > max) { max = grid[d][h]; peakDow = d; peakHour = h; }
      }
    }

    const fmtHour = (h) => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
    const hourHeader = Array.from({ length: 24 }, (_, h) => `<div class="hm-hour">${h % 3 === 0 ? h : ''}</div>`).join('');

    const bodyRows = DOW_LABELS.map((label, d) => {
      const rowCells = Array.from({ length: 24 }, (_, h) => {
        const count = grid[d][h];
        const intensity = max ? count / max : 0;
        const bg = count === 0 ? 'var(--surface-2)' : `color-mix(in srgb, var(--purple) ${Math.round(15 + intensity * 75)}%, var(--surface-2))`;
        const isPeak = count === max && count > 0;
        return `<div class="hm-cell${isPeak ? ' hm-peak' : ''}" style="background:${bg}" title="${label} ${fmtHour(h)}: ${count} booking${count === 1 ? '' : 's'}"></div>`;
      }).join('');
      return `<div class="hm-row"><div class="hm-label">${label}</div>${rowCells}</div>`;
    }).join('');

    el.innerHTML = `
      <div class="heatmap">
        <div class="hm-row hm-header"><div class="hm-label"></div>${hourHeader}</div>
        ${bodyRows}
      </div>
      <div class="hm-legend">
        <span>Fewer</span><span class="hm-scale"></span><span>More</span>
        <span class="hm-legend-note">${MIDDOT} peak: ${DOW_LABELS[peakDow]} ${fmtHour(peakHour)}, ${max} booking${max === 1 ? '' : 's'}</span>
      </div>`;
  }

  // ----------------------------------------------------------------- trend
  // Compact axis label -- "5 Aug", no year, so it fits stacked under 90
  // daily bars without wrapping or overlapping its neighbours.
  const fmtAxisDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  // Evenly-spaced tick indices, always including the first and last bucket,
  // capped at maxTicks so 90 daily bars don't render 90 overlapping labels.
  function axisTickIndexes(n, maxTicks = 6) {
    if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i);
    const step = (n - 1) / (maxTicks - 1);
    const idx = new Set();
    for (let i = 0; i < maxTicks; i++) idx.add(Math.round(i * step));
    return [...idx].sort((a, b) => a - b);
  }

  const AXIS_H = 16; // reserved strip below the plot for date labels

  function axisLabels(dates, plotWidth) {
    const n = dates.length;
    const stepX = plotWidth / Math.max(1, n - 1);
    return axisTickIndexes(n).map(i => {
      const x = n === 1 ? plotWidth / 2 : i * stepX;
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="${AXIS_H - 4}" font-size="8" fill="var(--ink-3)" text-anchor="${anchor}">${escapeHtml(fmtAxisDate(dates[i]))}</text>`;
    }).join('');
  }

  // A hover-only tooltip is easy to miss (slow native rendering, and does
  // not exist at all on touch) and was not good enough on its own. When
  // there are few enough bars/points to fit without overlapping, print the
  // value directly on the chart; the <title> tooltip stays as a fallback
  // for the dense daily case where nothing could be printed legibly.
  const MAX_PRINTED_VALUES = 18;

  // dates/tooltips are parallel to values: dates drives the x-axis labels,
  // tooltips is the full hover text. valueFmt renders the short on-chart
  // label ("$245") when the bucket count is low enough to print one per bar.
  function svgBars(values, { width = 320, height = 100, color, dates = [], tooltips = [], valueFmt }) {
    const plotH = height - 2;
    const n = values.length;
    const printValues = valueFmt && n <= MAX_PRINTED_VALUES;
    const topMargin = printValues ? 20 : 12; // extra headroom for the label above the tallest bar
    const max = Math.max(...values, 1);
    const gap = n > 20 ? 1.5 : 6;
    const barW = (width - gap * (n - 1)) / n;
    const bars = values.map((v, i) => {
      const h = (v / max) * (plotH - topMargin);
      const x = i * (barW + gap);
      const y = plotH - h - 2;
      const cx = x + barW / 2;
      const title = tooltips[i] ? `<title>${escapeHtml(tooltips[i])}</title>` : '';
      const rect = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barW, 0.5).toFixed(1)}" height="${h.toFixed(1)}" rx="${barW > 4 ? 2 : 0}" fill="${color}">${title}</rect>`;
      const label = printValues
        ? `<text x="${cx.toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="8" fill="var(--ink-2)" text-anchor="middle">${escapeHtml(valueFmt(v))}</text>`
        : '';
      return rect + label;
    }).join('');
    const axis = dates.length ? axisLabels(dates, width) : '';
    return `<svg viewBox="0 0 ${width} ${height + AXIS_H}" role="img">${bars}<line x1="0" y1="${plotH - 1}" x2="${width}" y2="${plotH - 1}" stroke="var(--hairline)" stroke-width="1"/><g transform="translate(0,${plotH})">${axis}</g></svg>`;
  }

  function svgLines(series, { width = 320, height = 100, dates = [], valueFmt }) {
    const plotH = height - 2;
    const allVals = series.flatMap(s => s.values);
    const max = Math.max(...allVals, 1);
    const n = series[0].values.length;
    const printValues = valueFmt && n <= MAX_PRINTED_VALUES;
    // Extra top and bottom margin so a printed label has room whether the
    // point it belongs to sits near the top or bottom of the plot.
    const topPad = printValues ? 12 : 4;
    const stepX = width / Math.max(1, n - 1);
    const scaleY = (v) => (plotH - 14) - (v / max) * (plotH - 20 - (printValues ? 8 : 0)) + topPad;

    const parts = series.map(s => {
      const solidIdx = s.dashedFrom != null ? s.dashedFrom : n;
      const pts = s.values.map((v, i) => `${(i * stepX).toFixed(1)},${scaleY(v).toFixed(1)}`);
      const solid = pts.slice(0, solidIdx + 1).join(' ');
      const dashed = pts.slice(Math.max(0, solidIdx)).join(' ');
      let out = '';
      if (solid) out += `<polyline points="${solid}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
      if (dashed && s.dashedFrom != null) out += `<polyline points="${dashed}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="3,3" opacity="0.55"/>`;
      // A marker on every point, not just the last -- with n up around 90
      // for a daily-bucketed range these are necessarily small, but a dot
      // to hover for the exact value beats a bare line with one endpoint.
      const r = n > 40 ? 1.5 : n > 14 ? 2 : 3;
      s.values.forEach((v, i) => {
        const cx = (i * stepX).toFixed(1);
        const cy = scaleY(v).toFixed(1);
        const title = dates[i] ? `<title>${escapeHtml(fmtAxisDate(dates[i]))}: ${escapeHtml(String(s.tooltips ? s.tooltips[i] : v))}</title>` : '';
        out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}">${title}</circle>`;
        if (printValues) {
          // Alternate above/below the point -- consecutive labels sitting
          // directly on top of each other is the more likely collision than
          // one from two points apart, since points are evenly spaced.
          const dy = i % 2 === 0 ? -5 : 11;
          out += `<text x="${cx}" y="${(scaleY(v) + dy).toFixed(1)}" font-size="8" fill="var(--ink-2)" text-anchor="middle">${escapeHtml(valueFmt(v))}</text>`;
        }
      });
      return out;
    }).join('');
    const axis = dates.length ? axisLabels(dates, width) : '';
    return `<svg viewBox="0 0 ${width} ${height + AXIS_H}" role="img">${parts}<line x1="0" y1="${plotH - 1}" x2="${width}" y2="${plotH - 1}" stroke="var(--hairline)" stroke-width="1"/><g transform="translate(0,${plotH})">${axis}</g></svg>`;
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
    // bucketRange's own threshold, not the resulting bucket count -- a
    // 90-day range collapses to ~13 weekly buckets, which is nowhere near
    // 31, so checking buckets.length here previously mislabelled genuinely
    // weekly bars as "per day".
    const weekly = daysCount(state.from, state.to) > 31;
    // The date shown on hover/axis for a weekly bucket is its first day --
    // consistent with how the legend already describes weekly buckets ("per
    // week") rather than implying the bucket is a single day.
    const dates = buckets.map(b => b.start);
    const bucketLabel = (b) => weekly ? `Week of ${fmtDate(b.start)}` : fmtDate(b.start);
    const fmtMoneyShort = (n) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmtMoney(n);

    const spendByBucket = buckets.map(b => spendFor(b.start, b.end).reduce((s, r) => s + r.spend, 0));
    document.getElementById('trend-spend').innerHTML = svgBars(spendByBucket, {
      color: 'var(--cat-1)',
      dates,
      tooltips: buckets.map((b, i) => `${bucketLabel(b)}: ${fmtMoney(spendByBucket[i])}`),
      valueFmt: fmtMoneyShort,
    });
    document.getElementById('trend-spend-legend').textContent =
      `Spend ($${Math.min(...spendByBucket).toLocaleString()}${DASH_EN}$${Math.max(...spendByBucket).toLocaleString()} per ${weekly ? 'week' : 'day'})`;

    // Cost per link click, bucket by bucket. Spend alone says how much went
    // out; this says whether each dollar is buying more or fewer people, and
    // it is the earliest warning that a creative is fatiguing.
    const cpcByBucket = buckets.map(b => {
      const rows = spendFor(b.start, b.end);
      const s = rows.reduce((acc, r) => acc + r.spend, 0);
      const c = rows.reduce((acc, r) => acc + (r.inlineLinkClicks || 0), 0);
      return c ? s / c : 0;
    });
    document.getElementById('trend-funnel').innerHTML = svgLines(
      [{
        values: cpcByBucket,
        color: 'var(--cat-2)',
        dashedFrom: null,
        tooltips: cpcByBucket.map(v => v ? '$' + v.toFixed(2) : 'no link clicks'),
      }],
      { dates, valueFmt: (v) => v ? '$' + v.toFixed(2) : DASH }
    );
    const priced = cpcByBucket.filter(v => v > 0);
    document.getElementById('trend-cpc-legend').textContent = priced.length
      ? `$${Math.min(...priced).toFixed(2)}${DASH_EN}$${Math.max(...priced).toFixed(2)} per link click`
      : 'no link clicks in range';

    // How we're tracking on leads, not just spend -- same buckets as the
    // charts above so a spend spike and a bookings dip line up visually.
    const bookingsConnected = LEADS.length > 0;
    const leadsByBucket = buckets.map(b => leadsFor(b.start, b.end).length);
    document.getElementById('trend-leads').innerHTML = bookingsConnected
      ? svgBars(leadsByBucket, {
          color: 'var(--cat-4)',
          dates,
          tooltips: buckets.map((b, i) => `${bucketLabel(b)}: ${leadsByBucket[i]} booked`),
          valueFmt: (v) => String(v),
        })
      : '';
    document.getElementById('trend-leads-legend').textContent = bookingsConnected
      ? `${Math.min(...leadsByBucket)}${DASH_EN}${Math.max(...leadsByBucket)} bookings per ${weekly ? 'week' : 'day'}`
      : 'booking sheet not synced';
  }

  // ----------------------------------------------------------------- table
  function renderTable() {
    const { from, to } = state;
    const rangeSpend = spendFor(from, to);
    const rangeLeads = leadsFor(from, to);
    const rangeOptins = optinsFor(from, to);

    // Campaigns present in this range/filter combo -- read off the data,
    // not a fixed list. Audience/Creative/Landing Page shown are whatever
    // the first matching spend row for that campaign carries.
    const campaignNames = uniqSorted(rangeSpend.map(r => r.campaign));

    const rows = campaignNames.map(name => {
      const spendRows = rangeSpend.filter(r => r.campaign === name);
      const sum = (key) => spendRows.reduce((s, r) => s + (r[key] || 0), 0);
      const spend = sum('spend');
      const impressions = sum('impressions');
      const linkClicks = sum('inlineLinkClicks');
      const ctr = impressions ? (linkClicks / impressions) * 100 : null;
      const cpc = linkClicks ? spend / linkClicks : null;

      const bookings = rangeLeads.filter(l => l.campaign === name).length;
      const downloads = rangeOptins.filter(o => o.campaign === name).length;
      const costPerLead = bookings ? spend / bookings : null;

      // Ranked on cost per qualified lead where bookings exist, and on cost
      // per click otherwise. Grading a campaign 'critical' for having no
      // bookings when most bookings carry no campaign at all would condemn
      // campaigns for a gap in attribution rather than in performance.
      let status;
      if (costPerLead != null) {
        status = costPerLead < 150 ? 'good' : costPerLead < 400 ? 'warning' : 'critical';
      } else if (cpc == null) {
        status = null;
      } else {
        status = cpc < 2 ? 'good' : cpc < 5 ? 'warning' : 'critical';
      }

      return {
        name, audience: spendRows[0].audience, creative: spendRows[0].creative, landingPage: spendRows[0].landingPage,
        spend, impressions, linkClicks, ctr, cpc, downloads, bookings, costPerLead, status,
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

    const noBookings = LEADS.length === 0;
    document.getElementById('campaign-table-body').innerHTML = rows.map(r => `
      <tr>
        <td>${r.status ? `<span class="status-dot ${r.status}"></span>` : ''}${escapeHtml(r.name)}</td>
        <td class="dim">${escapeHtml(r.audience)}</td>
        <td class="dim">${escapeHtml(r.creative)}</td>
        <td>${fmtMoney(r.spend)}</td>
        <td>${r.impressions.toLocaleString()}</td>
        <td>${r.linkClicks.toLocaleString()}</td>
        <td>${r.ctr != null ? r.ctr.toFixed(2) + '%' : DASH}</td>
        <td>${r.cpc != null ? '$' + r.cpc.toFixed(2) : DASH}</td>
        <td>${r.downloads || `<span class="pending">${DASH}</span>`}</td>
        <td>${noBookings ? `<span class="pending">${DASH}</span>` : r.bookings}</td>
        <td>${fmtMoney(r.costPerLead)}</td>
      </tr>
    `).join('') || `<tr><td colspan="11" style="color:var(--ink-3);font-style:italic">No campaigns match the current filters.</td></tr>`;

    document.querySelectorAll('#campaign-table th[data-key]').forEach(th => {
      th.classList.toggle('sorted', th.dataset.key === sortState.key);
    });
  }

  function initTableSort() {
    document.querySelectorAll('#campaign-table th[data-key]').forEach(th => {
      th.onclick = () => {
        const key = th.dataset.key;
        if (sortState.key === key) sortState.dir *= -1;
        else { sortState.key = key; sortState.dir = 1; }
        renderTable();
      };
    });
  }

  // ------------------------------------------------------------------ init
  // Each section runs independently -- a bug in, say, the funnel shouldn't
  // also blank out the KPI tiles and table that would otherwise render fine.
  function renderAll() {
    const sections = [renderMonthlyPacing, renderKpisMarketing, renderKpisJourney, renderUnattributed, renderFunnel, renderTrend, renderCampaignSpend, renderBookingHeatmap, renderTable];
    for (const fn of sections) {
      try { fn(); } catch (err) { showFatalError(err); }
    }
  }

  try { initFilterBar(); } catch (err) { showFatalError(err); }
  try { initTableSort(); } catch (err) { showFatalError(err); }
  renderAll();
}
