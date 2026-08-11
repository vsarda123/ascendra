/*
  Data loader for the Ascendra Financial Meta Ads dashboard.

  Tries /api/data (Meta + ClickFunnels + Google Sheets, see api/data.js)
  first. If that endpoint isn't configured yet, errors, or simply returns
  no rows, this falls back to a deterministic mock generator so the
  dashboard always renders something rather than breaking. app.js is loaded
  up front via a plain script tag (see index.html) -- this file just calls
  window.renderDashboard(data) once data is ready.
*/
(async function () {
  // Defined in index.html before this file loads; guarded anyway so this
  // file still works if that inline block is ever removed.
  const log = window.bootLog || function () {};
  log('data.js IIFE entered');

  const MATURITY_DAYS = 35; // ~5 weeks -- a cohort is "matured" once every
  // downstream stage has had time to resolve.

  // Built from character codes rather than typed literally -- keeps this
  // file plain ASCII end to end, immune to any encoding mangling a literal
  // em-dash/checkmark could suffer somewhere in a deploy/transport pipeline.
  const CHECK = String.fromCharCode(10003);
  const CROSS = String.fromCharCode(10007);
  const MIDDOT = String.fromCharCode(183);
  const DASH = String.fromCharCode(8212);
  const DASH_EN = String.fromCharCode(8211);

  // ---------------------------------------------------------- mock fallback
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildMockData() {
    const rng = mulberry32(20260804);
    const rand = (min, max) => min + rng() * (max - min);
    const SIM_TODAY = new Date('2026-08-04T00:00:00');

    function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
    function isoDate(d) { return d.toISOString().slice(0, 10); }

    const HISTORY_DAYS = 98;
    const DATES = Array.from({ length: HISTORY_DAYS }, (_, i) => isoDate(addDays(SIM_TODAY, -(HISTORY_DAYS - 1 - i))));
    const TODAY = DATES[DATES.length - 1];
    const EARLIEST = DATES[0];

    const _MOCK_CAMPAIGN_DEFS = [
      { campaign: `Rate Rise Anxiety ${DASH_EN} Retarget`, audience: 'Website visitors, 30d', creative: '"Are You Overpaying" static', landingPage: '/rate-check', baseWeeklySpend: 2100, baseCpc: 1.55, bookRate: 0.024 },
      { campaign: `Refinance ${DASH_EN} Owner Occupier`, audience: '1% Lookalike, refinancers', creative: '"Rate Check" video', landingPage: '/refinance-check', baseWeeklySpend: 6100, baseCpc: 2.05, bookRate: 0.016 },
      { campaign: `First Home Buyer ${DASH_EN} FOMO`, audience: 'Interest: first home buyers', creative: 'Deposit calculator carousel', landingPage: '/first-home-buyer', baseWeeklySpend: 5000, baseCpc: 1.95, bookRate: 0.013 },
      { campaign: `Broad Prospecting ${DASH_EN} 3% LAL`, audience: '3% Lookalike, all customers', creative: '"Meet the Team" video', landingPage: '/home', baseWeeklySpend: 3850, baseCpc: 1.70, bookRate: 0.009 },
    ];

    const DAILY_SPEND = [];
    for (const date of DATES) {
      for (const c of _MOCK_CAMPAIGN_DEFS) {
        const spend = Math.round((c.baseWeeklySpend / 7) * rand(0.7, 1.35));
        const cpc = c.baseCpc * rand(0.85, 1.18);
        const clicks = Math.round(spend / cpc);
        const lpViewRate = rand(0.78, 0.92);
        const landingPageViews = Math.round(clicks * lpViewRate);
        DAILY_SPEND.push({
          date, spend, clicks, landingPageViews,
          campaign: c.campaign, audience: c.audience, creative: c.creative, landingPage: c.landingPage,
        });
      }
    }

    let leadSeq = 1;
    const LEADS = [];
    for (const date of DATES) {
      const daysAgo = HISTORY_DAYS - 1 - DATES.indexOf(date);
      const matured = daysAgo >= MATURITY_DAYS;

      for (const c of _MOCK_CAMPAIGN_DEFS) {
        const spendRow = DAILY_SPEND.find(r => r.date === date && r.campaign === c.campaign);
        const bookings = Math.round(spendRow.landingPageViews * c.bookRate * rand(0.5, 1.6));

        for (let i = 0; i < bookings; i++) {
          const unattributed = rng() < 0.04;
          const attended = rng() < 0.76;
          const optionsSent = attended && rng() < 0.72;
          const approved = optionsSent && rng() < 0.67;
          const canHaveSettled = approved && matured;
          const settled = canHaveSettled && rng() < 0.72;

          LEADS.push({
            id: 'L' + (leadSeq++),
            generatedDate: date,
            campaign: unattributed ? null : c.campaign,
            audience: unattributed ? null : c.audience,
            creative: unattributed ? null : c.creative,
            landingPage: unattributed ? null : c.landingPage,
            attended, optionsSent, approved, settled, matured,
          });
        }
      }
    }

    return { DATES, TODAY, EARLIEST, MATURITY_DAYS, DAILY_SPEND, LEADS };
  }

  // -------------------------------------------------------------- live data
  // Deliberately linear: one fetch, one parse, one timeout. An earlier
  // version raced an AbortController, two setInterval tickers, an 8s parse
  // timeout and a 15s watchdog against each other; that could wedge with the
  // badge frozen mid-stage and no render ever happening. Fewer moving parts
  // is the fix -- fetch() with an AbortSignal covers the only case that can
  // actually hang (a stalled network), and everything after it is fast.
  async function loadLiveData() {
    log('fetch(/api/data) starting');
    const res = await fetch('/api/data', {
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    });
    log('fetch resolved: HTTP ' + res.status + ', reading body');
    if (!res.ok) throw new Error(`/api/data returned HTTP ${res.status}`);

    const json = await res.json();
    const rows = (json && Array.isArray(json.dailySpend)) ? json.dailySpend.length : 0;
    log('body parsed: ' + rows + ' dailySpend rows, dataSource=' + (json && json.dataSource));
    return { empty: rows === 0, meta: json };
  }

  // Live Meta data always has real campaign/audience/creative/spend/clicks --
  // that part of the pipeline is proven working. What's frequently NOT wired
  // up yet is the landing-page mapping (data-sources.config.js CAMPAIGN_PAGE_MAP
  // starts empty) and the Sheets/CRM lead ledger (needs its own service-account
  // setup). Rather than showing those sections fully blank while the rest of
  // the dashboard has real numbers, backfill plausible placeholder values
  // derived FROM the real rows, clearly flagged in sourceInfo.placeholders so
  // the badge and DIAG panel both say so -- this lets every section of the UI
  // be exercised and verified even before every source is fully connected.
  function slugify(name) {
    return '/' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function backfillLandingPages(dailySpend) {
    const bySlug = {};
    let usedPlaceholder = false;
    const rows = dailySpend.map(r => {
      if (r.landingPage) return r;
      usedPlaceholder = true;
      if (!bySlug[r.campaign]) bySlug[r.campaign] = slugify(r.campaign);
      return { ...r, landingPage: bySlug[r.campaign] };
    });
    return { rows, usedPlaceholder };
  }

  function synthesizePlaceholderLeads(dailySpend, todayStr) {
    const rng = mulberry32(20260804);
    const rand = (min, max) => min + rng() * (max - min);
    const leads = [];
    let seq = 1;
    for (const row of dailySpend) {
      const daysAgo = Math.round((new Date(todayStr + 'T00:00:00Z') - new Date(row.date + 'T00:00:00Z')) / 86400000);
      const matured = daysAgo >= MATURITY_DAYS;
      // Capped at 3/row regardless of click volume -- this only needs to
      // look plausible, not model real conversion rates, and an uncapped
      // formula against real (much higher than mock) click counts could
      // generate a very large LEADS array that every render pass below then
      // has to filter over repeatedly.
      const bookings = Math.min(3, Math.round((row.clicks || 0) * 0.004 * rand(0.4, 1.6)));
      for (let i = 0; i < bookings; i++) {
        const attended = rng() < 0.76;
        const optionsSent = attended && rng() < 0.72;
        const approved = optionsSent && rng() < 0.67;
        const settled = approved && matured && rng() < 0.72;
        leads.push({
          id: 'P' + (seq++),
          generatedDate: row.date,
          campaign: row.campaign,
          audience: row.audience,
          creative: row.creative,
          landingPage: row.landingPage,
          attended, optionsSent, approved, settled,
        });
      }
    }
    return leads;
  }

  function toDashboardData(json) {
    const { rows: dailySpend, usedPlaceholder: landingPagePlaceholder } = backfillLandingPages(json.dailySpend);
    const dates = [...new Set(dailySpend.map(r => r.date))].sort();
    const today = dates[dates.length - 1];
    const earliest = dates[0];

    let leadsRaw = json.leads || [];
    let leadsPlaceholder = false;
    if (leadsRaw.length === 0 && dailySpend.length > 0) {
      leadsRaw = synthesizePlaceholderLeads(dailySpend, today);
      leadsPlaceholder = true;
    }

    const leads = leadsRaw.map(l => {
      const daysAgo = Math.round((new Date(today + 'T00:00:00Z') - new Date(l.generatedDate + 'T00:00:00Z')) / 86400000);
      return { ...l, matured: daysAgo >= MATURITY_DAYS };
    });

    return {
      DATES: dates, TODAY: today, EARLIEST: earliest, MATURITY_DAYS, DAILY_SPEND: dailySpend, LEADS: leads,
      placeholders: { leads: leadsPlaceholder, landingPage: landingPagePlaceholder },
    };
  }

  // ------------------------------------------------------------------ boot
  // Render is never gated on the network. Sample data paints the full
  // dashboard within milliseconds of the script running, then the live Meta
  // numbers replace it in place once /api/data answers. Previously a single
  // slow or stalled fetch left every section permanently blank, because
  // nothing rendered at all until the request had resolved one way or the
  // other -- there was no reason for the shell to wait on it.
  let data, sourceInfo;

  function publish() {
    window.DASHBOARD_DATA = data;
    window.DASHBOARD_SOURCE_INFO = sourceInfo;
    renderSourceBadge();
    if (typeof window.renderDashboard === 'function') {
      window.renderDashboard(data);
      log('renderDashboard() returned');
    } else {
      log('*** window.renderDashboard is not a function -- app.js did not load');
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#d0393f;color:#fff;padding:14px 20px;font-family:monospace;font-size:12.5px;';
      banner.textContent = 'Dashboard error (send this to Claude): app.js did not load -- window.renderDashboard is not defined.';
      document.body.prepend(banner);
    }
  }

  data = buildMockData();
  log('mock data built: ' + data.DAILY_SPEND.length + ' spend rows');
  sourceInfo = { mode: 'mock', loading: true };
  publish();
  log('first render (sample data) complete');

  try {
    const live = await loadLiveData();
    if (live && !live.empty) {
      data = toDashboardData(live.meta);
      sourceInfo = { mode: 'live', sources: live.meta.sources, errors: live.meta.errors, dataSource: live.meta.dataSource, placeholders: data.placeholders };
      log('live data prepared: ' + data.DAILY_SPEND.length + ' spend rows, ' + data.LEADS.length + ' leads');
    } else {
      sourceInfo = { mode: 'mock', sources: live ? live.meta.sources : null, errors: live ? live.meta.errors : null };
      log('live data was empty, staying on sample data');
    }
  } catch (e) {
    sourceInfo = { mode: 'mock', error: `${e.name}: ${e.message}` };
    log('*** live load FAILED: ' + e.name + ': ' + e.message);
  }
  publish();
  log('final render complete, mode=' + sourceInfo.mode);

  function renderSourceBadge() {
    const el = document.getElementById('source-badge');
    if (!el) return;
    if (sourceInfo.loading) {
      el.textContent = `Sample data shown ${DASH} loading live Meta data...`;
      el.className = 'source-badge mock';
      return;
    }
    if (sourceInfo.mode === 'live') {
      const s = sourceInfo.sources || {};
      const p = sourceInfo.placeholders || {};
      const parts = [
        `Meta ${s.meta ? CHECK : CROSS}`,
        `ClickFunnels ${s.clickfunnels ? CHECK : CROSS}`,
        `Sheet ${s.sheets ? CHECK : CROSS}`,
        `rows:${(D => D && D.DAILY_SPEND ? D.DAILY_SPEND.length : 0)(data)}`,
      ];
      if (p.leads) parts.push('leads:PLACEHOLDER (connect Sheet to replace)');
      if (p.landingPage) parts.push('landing page:PLACEHOLDER (map CAMPAIGN_PAGE_MAP to replace)');
      el.textContent = `Live data ${MIDDOT} ${parts.join(' ' + MIDDOT + ' ')}`;
      el.className = 'source-badge live';
    } else {
      el.textContent = sourceInfo.error ? `Sample data ${DASH} live fetch failed: ${sourceInfo.error}` : `Sample data ${DASH} no data source connected yet`;
      el.className = 'source-badge mock';
    }
  }
})();
