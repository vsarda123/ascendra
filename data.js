/*
  Data loader for the Ascendra Financial Meta Ads dashboard.

  Tries /api/data (Meta + ClickFunnels + Google Sheets, see api/data.js)
  first. If that endpoint isn't configured yet, errors, or simply returns no
  rows, the dashboard renders with real zeros/blanks instead -- no invented
  numbers stand in for a source that isn't connected yet. app.js is loaded
  up front via a plain script tag (see index.html) -- this file just calls
  window.renderDashboard(data) once data is ready.
*/
(async function () {
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

  // ------------------------------------------------------------ empty shell
  // No invented numbers. Before live data arrives, and whenever it comes
  // back empty, every section reads a real zero/blank instead -- app.js
  // already renders that cleanly (dashed-out KPIs, "not connected" funnel
  // stages, an empty table), so there's nothing to synthesize here beyond
  // today's real date for the range pickers to anchor on.
  function isoDate(d) { return d.toISOString().slice(0, 10); }

  function buildEmptyData() {
    const today = isoDate(new Date());
    return { DATES: [], TODAY: today, EARLIEST: today, MATURITY_DAYS, DAILY_SPEND: [], LEADS: [], OPTINS: [], ATTRIBUTION: null };
  }

  // -------------------------------------------------------------- live data
  // Deliberately linear: one fetch, one parse, one timeout. An earlier
  // version raced an AbortController, two setInterval tickers, an 8s parse
  // timeout and a 15s watchdog against each other; that could wedge with the
  // badge frozen mid-stage and no render ever happening. Fewer moving parts
  // is the fix -- fetch() with an AbortSignal covers the only case that can
  // actually hang (a stalled network), and everything after it is fast.
  async function loadLiveData() {
    const res = await fetch('/api/data', {
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`/api/data returned HTTP ${res.status}`);

    const json = await res.json();
    const rows = (json && Array.isArray(json.dailySpend)) ? json.dailySpend.length : 0;
    return { empty: rows === 0, meta: json };
  }

  // Live Meta data always has real campaign/audience/creative/spend/clicks --
  // that part of the pipeline is proven working. What's frequently NOT wired
  // up yet is the landing-page mapping (data-sources.config.js CAMPAIGN_PAGE_MAP
  // starts empty). Rows without one keep landingPage as null rather than a
  // guessed slug -- app.js already drops nulls from the landing-page filter
  // and simply doesn't show one in the table, so there's nothing to invent.
  function hasUnmappedLandingPage(dailySpend) {
    return dailySpend.some(r => !r.landingPage);
  }

  function toDashboardData(json) {
    const dailySpend = json.dailySpend;
    const landingPagePlaceholder = hasUnmappedLandingPage(dailySpend);
    const dates = [...new Set(dailySpend.map(r => r.date))].sort();
    const today = dates[dates.length - 1];
    const earliest = dates[0];

    // No lead source connected means no leads -- full stop. This used to
    // synthesize plausible-looking bookings, attendance, approvals and
    // settlements from a seeded RNG whenever the ledger was empty. Every
    // number below "Ad Clicks" was then invented, while the page presented
    // them identically to the real Meta figures above. That is worse than
    // an empty section on a dashboard meant for spend decisions.
    // leads are booked meetings (the qualified lead); optins are guide
    // downloads, an earlier and much larger stage. Cost per lead is measured
    // against the former.
    const leadsRaw = json.leads || [];
    const optins = json.optins || [];
    const leadsMissing = leadsRaw.length === 0;

    const leads = leadsRaw.map(l => {
      const daysAgo = Math.round((new Date(today + 'T00:00:00Z') - new Date(l.generatedDate + 'T00:00:00Z')) / 86400000);
      return { ...l, matured: daysAgo >= MATURITY_DAYS };
    });

    return {
      DATES: dates, TODAY: today, EARLIEST: earliest, MATURITY_DAYS,
      DAILY_SPEND: dailySpend, LEADS: leads, OPTINS: optins,
      ATTRIBUTION: json.attribution || null,
      placeholders: { leadsMissing, landingPage: landingPagePlaceholder },
    };
  }

  // ------------------------------------------------------------------ boot
  // Render is never gated on the network. The empty shell paints the full
  // dashboard (all real zeros/blanks) within milliseconds of the script
  // running, then the live Meta numbers replace it in place once /api/data
  // answers. Previously a single slow or stalled fetch left every section
  // permanently blank, because nothing rendered at all until the request had
  // resolved one way or the other -- there was no reason for the shell to
  // wait on it.
  let data, sourceInfo;

  function publish() {
    window.DASHBOARD_DATA = data;
    window.DASHBOARD_SOURCE_INFO = sourceInfo;
    renderSourceBadge();
    if (typeof window.renderDashboard === 'function') {
      window.renderDashboard(data);
    } else {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#d0393f;color:#fff;padding:14px 20px;font-family:monospace;font-size:12.5px;';
      banner.textContent = 'Dashboard error (send this to Claude): app.js did not load -- window.renderDashboard is not defined.';
      document.body.prepend(banner);
    }
  }

  data = buildEmptyData();
  sourceInfo = { mode: 'loading', loading: true };
  publish();

  try {
    const live = await loadLiveData();
    if (live && !live.empty) {
      data = toDashboardData(live.meta);
      sourceInfo = { mode: 'live', sources: live.meta.sources, errors: live.meta.errors, dataSource: live.meta.dataSource, placeholders: data.placeholders };
    } else {
      sourceInfo = { mode: 'empty', sources: live ? live.meta.sources : null, errors: live ? live.meta.errors : null };
    }
  } catch (e) {
    sourceInfo = { mode: 'empty', error: `${e.name}: ${e.message}` };
  }
  publish();

  function renderSourceBadge() {
    const el = document.getElementById('source-badge');
    if (!el) return;
    if (sourceInfo.loading) {
      el.textContent = 'Loading live Meta data...';
      el.className = 'source-badge empty';
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
      if (p.leadsMissing) parts.push('no lead source connected');
      if (p.landingPage) parts.push('landing page unmapped');
      el.textContent = `Live data ${MIDDOT} ${parts.join(' ' + MIDDOT + ' ')}`;
      el.className = 'source-badge live';
    } else {
      el.textContent = sourceInfo.error ? `No data ${DASH} live fetch failed: ${sourceInfo.error}` : `No data source connected yet`;
      el.className = 'source-badge empty';
    }
  }
})();
