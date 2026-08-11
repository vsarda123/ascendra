const { google } = require('googleapis');
const { CAMPAIGN_PAGE_MAP, SHEET_TAB_CAMPAIGN_MAP } = require('../data-sources.config');

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function truthy(v) { return /^(true|yes|y|1)$/i.test(String(v || '').trim()); }

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------- Meta
// Meta returns some metrics as plain numbers (impressions, reach,
// inline_link_clicks) and others as an "actions" array of
// {action_type, value} pairs (outbound_clicks, video_*_watched_actions).
// This sums whichever shape shows up so callers don't have to care.
function actionValue(field) {
  if (field == null) return 0;
  if (Array.isArray(field)) return field.reduce((s, a) => s + (parseFloat(a.value) || 0), 0);
  return Number(field) || 0;
}

async function fetchMetaInsights(since, until) {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  // impressions/reach/inline_link_clicks are plain numbers; outbound_clicks
  // and the video_* fields come back as actions arrays (see actionValue).
  // video_play_actions is Meta's own definition of a "3-second video play"
  // (their Ads Manager UI shows this exact field as "3-Second Video Plays"),
  // which is the numerator the user's hook-rate formula calls for.
  const fields = [
    'campaign_name', 'adset_name', 'ad_name', 'date_start',
    'spend', 'clicks', 'impressions', 'reach',
    'inline_link_clicks', 'outbound_clicks',
    'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
    'video_p75_watched_actions', 'video_p95_watched_actions', 'video_thruplay_watched_actions',
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
  ].join(',');
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  let url = `https://graph.facebook.com/v21.0/${account}/insights?level=ad&time_increment=1&time_range=${timeRange}&fields=${fields}&limit=500&access_token=${token}`;

  const rows = [];
  let pages = 0;
  const MAX_PAGES = 20;
  while (url && pages < MAX_PAGES) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error('Meta API: ' + j.error.message);
    for (const d of (j.data || [])) {
      rows.push({
        date: d.date_start,
        campaign: d.campaign_name,
        audience: d.adset_name,
        creative: d.ad_name,
        spend: parseFloat(d.spend || '0'),
        clicks: parseInt(d.clicks || '0', 10),
        impressions: parseInt(d.impressions || '0', 10),
        reach: parseInt(d.reach || '0', 10),
        inlineLinkClicks: parseInt(d.inline_link_clicks || '0', 10),
        outboundClicks: actionValue(d.outbound_clicks),
        videoPlays: actionValue(d.video_play_actions),
        videoP25: actionValue(d.video_p25_watched_actions),
        videoP50: actionValue(d.video_p50_watched_actions),
        videoP75: actionValue(d.video_p75_watched_actions),
        videoP95: actionValue(d.video_p95_watched_actions),
        videoThruplay: actionValue(d.video_thruplay_watched_actions),
        qualityRanking: d.quality_ranking || null,
        engagementRateRanking: d.engagement_rate_ranking || null,
        conversionRateRanking: d.conversion_rate_ranking || null,
      });
    }
    url = j.paging && j.paging.next ? j.paging.next : null;
    pages++;
  }
  return rows;
}

// Where each campaign's ads actually send people. Insights reports no
// destination, and the opt-in sheet records only a label ("Debt Recycling"),
// so this is the one authoritative link between a Meta campaign and a
// ClickFunnels page -- match these URLs against the funnel page URLs from
// discoverClickFunnelsPages to build CAMPAIGN_PAGE_MAP without guessing.
async function fetchMetaAdDestinations() {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  const fields = 'name,campaign{name},creative{link_url,object_story_spec,effective_object_story_id}';
  let url = `https://graph.facebook.com/v21.0/${account}/ads?fields=${fields}&limit=200&access_token=${token}`;

  const byCampaign = {};
  let pages = 0;
  while (url && pages < 10) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error('Meta API: ' + j.error.message);

    for (const ad of (j.data || [])) {
      const c = ad.creative || {};
      const spec = c.object_story_spec || {};
      const link =
        c.link_url ||
        (spec.link_data && spec.link_data.link) ||
        (spec.video_data && spec.video_data.call_to_action &&
          spec.video_data.call_to_action.value && spec.video_data.call_to_action.value.link) ||
        null;
      if (!link) continue;

      const campaign = (ad.campaign && ad.campaign.name) || '(unknown)';
      byCampaign[campaign] = byCampaign[campaign] || {};
      // Strip query strings: UTM tags vary per ad while the page does not.
      const clean = link.split('?')[0];
      byCampaign[campaign][clean] = (byCampaign[campaign][clean] || 0) + 1;
    }
    url = j.paging && j.paging.next ? j.paging.next : null;
    pages++;
  }

  return Object.entries(byCampaign).map(([campaign, links]) => ({
    campaign,
    destinations: Object.entries(links)
      .sort((a, b) => b[1] - a[1])
      .map(([url, adCount]) => ({ url, adCount })),
  }));
}

// ------------------------------------------------------------ ClickFunnels
async function fetchClickFunnelsWeekly(since, until) {
  const subdomain = process.env.CLICKFUNNELS_SUBDOMAIN;
  const token = process.env.CLICKFUNNELS_API_TOKEN;
  const pages = CAMPAIGN_PAGE_MAP.filter(m => m.clickfunnelsPageId);
  if (!pages.length) return {};

  const buckets = [];
  let cursor = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');
  while (cursor <= end) {
    let bEnd = addDays(cursor, 6);
    if (bEnd > end) bEnd = end;
    buckets.push({ start: new Date(cursor), end: bEnd });
    cursor = addDays(bEnd, 1);
  }

  const byCampaign = {};
  for (const p of pages) {
    byCampaign[p.campaign] = [];
    for (const b of buckets) {
      const qs = `timerange_start=${b.start.toISOString()}&timerange_end=${b.end.toISOString()}`;
      const r = await fetch(`https://${subdomain}.myclickfunnels.com/api/v2/pages/${p.clickfunnelsPageId}/stats?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (j.step) {
        byCampaign[p.campaign].push({
          start: isoDate(b.start), end: isoDate(b.end),
          views: j.step.views_all || 0, optins: j.step.optins || 0,
        });
      }
    }
  }
  return byCampaign;
}

// ------------------------------------------------------------- Google Sheets
// This is the raw opt-in ledger Zapier pushes to on every Calendly booking
// (via ClickFunnels): Date, First Name, Last Name, Email, Phone, Landing
// Page. There's no campaign/creative column -- Zapier/Calendly never knew
// which Meta ad drove the click -- so these leads can't be attributed to a
// specific campaign yet; they show up as "unattributed" on the dashboard,
// which is an honest reflection of what this data can tell us. Attendance/
// options-sent/approval/settlement live in MyCRM, not here, so those stay
// false until that connection exists.
function normalizeSheetDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Accepts whichever form the credential was pasted in. The natural thing to
// copy out of Google Cloud is the whole downloaded service-account JSON, and
// putting that in GOOGLE_SHEETS_PRIVATE_KEY fails with "No key or keyFile
// set" -- an error that points nowhere near the actual mistake. Pull the
// private_key (and the client email, so it need not be set twice) back out
// rather than making the format a thing to get right.
function googleCredentials() {
  const raw = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').trim();
  let key = raw;
  let email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      key = parsed.private_key || '';
      email = email || parsed.client_email;
    } catch {
      // Leave raw as-is; the caller surfaces the resulting auth error.
    }
  } else if (raw && !raw.includes('-----BEGIN')) {
    // Some setups base64 the whole PEM to dodge newline mangling in env vars.
    let decoded = '';
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      // Not base64; handled below.
    }
    if (decoded.includes('-----BEGIN')) {
      key = decoded;
    } else {
      // Otherwise this is the key's base64 body with its BEGIN/END lines
      // lost -- what you get copying the private_key value out of the
      // service-account JSON by hand and missing the wrapper. The bytes are
      // intact and usable, so put the wrapper back rather than requiring the
      // credential be re-pasted perfectly.
      const body = raw.replace(/\\n/g, '\n').replace(/\s+/g, '');
      if (body) {
        const wrapped = body.match(/.{1,64}/g).join('\n');
        key = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
      }
    }
  }

  return { email, key: key.replace(/\\n/g, '\n') };
}

// Finds a column by what its header says rather than by position, so
// inserting or reordering a column in the sheet does not silently shift
// every value into the wrong field.
function findColumn(headers, candidates) {
  const norm = headers.map(h => String(h || '').trim().toLowerCase());
  for (const want of candidates) {
    const i = norm.findIndex(h => h === want);
    if (i !== -1) return i;
  }
  for (const want of candidates) {
    const i = norm.findIndex(h => h.includes(want));
    if (i !== -1) return i;
  }
  return -1;
}

// Reads every tab in the opt-in workbook. Each tab is one lead magnet, and
// SHEET_TAB_CAMPAIGN_MAP ties the tab to the Meta campaign that paid for
// those opt-ins -- which is the only attribution available, since Zapier
// and Calendly never saw which ad drove the visit. Unmapped tabs still
// contribute their leads, just without a campaign.
async function fetchSheetLeads() {
  const { email, key } = googleCredentials();
  // Options object, not positional arguments. Current google-auth-library
  // takes only JWTOptions, so the old (email, keyFile, key, scopes) call
  // silently set no key and every request went out unauthenticated,
  // surfacing as "No key or keyFile set".
  const auth = new google.auth.JWT({
    email, key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = (meta.data.sheets || []).map(s => s.properties.title);
  const tabMap = Object.fromEntries(
    SHEET_TAB_CAMPAIGN_MAP.map(m => [m.tab.trim().toLowerCase(), m])
  );

  const leads = [];
  for (const tab of tabs) {
    // Tab titles carry stray spaces ("Debt recycling ") and must be quoted
    // in an A1 range or the API rejects it as unparseable.
    const range = `'${tab.replace(/'/g, "''")}'!A1:Z`;
    let rows;
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      rows = resp.data.values || [];
    } catch {
      continue; // A tab that cannot be read should not lose the others.
    }
    if (rows.length < 2) continue;

    const headers = rows[0];
    const iDate = findColumn(headers, ['date', 'timestamp', 'created', 'submitted']);
    const iFirst = findColumn(headers, ['first name', 'first', 'name']);
    const iLast = findColumn(headers, ['last name', 'last', 'surname']);
    const iEmail = findColumn(headers, ['email']);
    const iPhone = findColumn(headers, ['phone', 'mobile', 'number']);
    if (iDate === -1) continue;

    const mapping = tabMap[tab.trim().toLowerCase()];
    rows.slice(1).forEach((r, i) => {
      const generatedDate = normalizeSheetDate(r[iDate]);
      if (!generatedDate) return;
      leads.push({
        id: `${tab.trim()}#${i}`,
        generatedDate,
        firstName: iFirst !== -1 && r[iFirst] ? String(r[iFirst]).trim() : null,
        lastName: iLast !== -1 && r[iLast] ? String(r[iLast]).trim() : null,
        email: iEmail !== -1 && r[iEmail] ? String(r[iEmail]).trim() : null,
        phone: iPhone !== -1 && r[iPhone] ? String(r[iPhone]).trim() : null,
        sourceTab: tab.trim(),
        campaign: mapping ? mapping.campaign : null,
        audience: null,
        creative: null,
        landingPage: mapping ? mapping.landingPage || null : null,
        // These are outcomes that live in MyCRM, not in the opt-in ledger.
        // They stay false until that connection exists, and the dashboard
        // says so rather than implying nobody ever attended or settled.
        attended: false,
        optionsSent: false,
        approved: false,
        settled: false,
      });
    });
  }

  return leads;
}

// Discovers the workspace and its pages so CAMPAIGN_PAGE_MAP can be filled
// in without hunting for IDs by hand. Workspaces are not addressable
// directly: the documented chain is teams -> that team's workspaces ->
// that workspace's pages. An earlier version called /api/v2/workspaces,
// which is not a route and returned 404.
// A funnel step holds its page in one of three shapes: a plain page step, a
// split test wrapping one page per variant, or a conditional split with a
// page per branch. Flatten all three to the {stepName, pageId} pairs that
// CAMPAIGN_PAGE_MAP needs, since a split test's variants are exactly the
// pages whose stats are worth comparing.
function pagesInStep(step) {
  const out = [];
  const push = (page, label) => {
    if (!page) return;
    out.push({
      stepName: label,
      pageId: page.page_id || page.id || null,
      url: page.url || null,
    });
  };

  push(step.page, step.name);
  for (const v of step.variants || []) push(v.page || v, `${step.name} (variant)`);
  for (const b of step.branches || []) push(b.page || b, `${step.name} (branch)`);

  return out.filter(p => p.pageId);
}

async function discoverClickFunnelsPages() {
  const subdomain = process.env.CLICKFUNNELS_SUBDOMAIN;
  const token = process.env.CLICKFUNNELS_API_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const base = `https://${subdomain}.myclickfunnels.com/api/v2`;
  const out = {};

  const get = async (path) => {
    const r = await fetch(`${base}${path}`, { headers });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
  // The list endpoints return a bare array; tolerate a {data:[...]} wrapper
  // too rather than depending on which one this account's plan replies with.
  const asList = (body) => (Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []));

  const teams = await get('/teams');
  out.teamsStatus = teams.status;
  const teamList = asList(teams.body);
  out.teams = teamList.map(t => ({ id: t.id, name: t.name }));
  if (!teamList.length) { out.raw = teams.body; return out; }

  const teamId = teamList[0].id;
  out.resolvedTeamId = teamId;

  const workspaces = await get(`/teams/${teamId}/workspaces`);
  out.workspacesStatus = workspaces.status;
  const wsList = asList(workspaces.body);
  out.workspaces = wsList.map(w => ({ id: w.id, name: w.name }));
  if (!wsList.length) { out.raw = workspaces.body; return out; }

  const workspaceId = wsList[0].id;
  out.resolvedWorkspaceId = workspaceId;

  // Cursor pagination, keyed on the last id seen. The first response holds
  // exactly 20 records, which is a page rather than the whole account, and
  // stopping there hides every funnel created after the first twenty.
  const getAllPaged = async (path) => {
    const all = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await get(`${path}${after ? `${sep}after=${after}` : ''}`);
      const list = asList(r.body);
      all.push(...list);
      if (list.length < 20) break;
      after = list[list.length - 1].id;
      if (!after) break;
    }
    return all;
  };

  const pages = await get(`/workspaces/${workspaceId}/pages`);
  out.pagesStatus = pages.status;
  out.pages = asList(pages.body);
  if (!out.pages.length) out.raw = pages.body;

  // The workspace pages list is mostly theme scaffolding (checkout, blog,
  // 404). Real campaign landing pages are steps inside funnels, and it is
  // their page IDs that the stats endpoint wants, so walk the funnels too.
  const funnelList = await getAllPaged(`/workspaces/${workspaceId}/funnels`);
  out.funnelCount = funnelList.length;
  out.funnels = [];

  for (const f of funnelList) {
    // /funnels/{id}/structure, not /steps -- the latter is not a route and
    // 404s. Structure returns the flat, ordered step list from the funnel
    // builder, with each step's page nested inside it.
    const structure = await get(`/funnels/${f.id}/structure`);
    const steps = asList(structure.body && structure.body.steps ? structure.body.steps : structure.body);
    out.funnels.push({
      id: f.id,
      name: f.name,
      structureStatus: structure.status,
      steps: steps.flatMap(s => pagesInStep(s)),
    });
  }

  // The structure endpoint reports each page's internal workspace URL, which
  // is not necessarily the slug the page is actually published under -- an
  // ad can point at /diana-hemmad-loan-market-landing-page-ac11d while the
  // structure says /landing-page-page--2e0c1. Fetch the page records for the
  // real public paths, in parallel batches so ~50 lookups do not run past
  // the function's time limit.
  const allIds = out.funnels.flatMap(f => f.steps.map(s => s.pageId)).filter(Boolean);
  const details = {};
  for (let i = 0; i < allIds.length; i += 10) {
    const batch = allIds.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (id) => {
      try {
        const p = await get(`/pages/${id}`);
        return [id, p.body];
      } catch {
        return [id, null];
      }
    }));
    for (const [id, body] of results) {
      if (!body) continue;
      details[id] = {
        name: body.name || null,
        path: body.path || body.slug || null,
        publicUrl: body.public_url || body.url || null,
        // path came back null for every page, so the slug lives under some
        // other key. Carry any field whose value looks like a path so the
        // right one can be identified instead of guessed at.
        pathLike: Object.entries(body)
          .filter(([, v]) => typeof v === 'string' && /^\/?[a-z0-9]+(-[a-z0-9]+)+\/?$/i.test(v))
          .map(([k, v]) => `${k}=${v}`),
      };
    }
  }
  out.pageDetails = details;

  return out;
}

function mergeDailySpend(metaRows, cfByCampaign) {
  const pageMeta = Object.fromEntries(CAMPAIGN_PAGE_MAP.map(m => [m.campaign, m]));

  return metaRows.map(row => {
    const mapping = pageMeta[row.campaign];
    let landingPageViews = 0;
    if (mapping && cfByCampaign[row.campaign]) {
      const bucket = cfByCampaign[row.campaign].find(b => row.date >= b.start && row.date <= b.end);
      if (bucket) {
        const bucketDays = (new Date(bucket.end) - new Date(bucket.start)) / 86400000 + 1;
        landingPageViews = Math.round(bucket.views / bucketDays);
      }
    }
    // Everything fetchMetaInsights asked Meta for is carried through, not
    // just spend/clicks. The impression -> reach -> click -> outbound-click
    // steps are the only drop-off the ad platform can actually see, and the
    // video quartiles are what tell you whether a creative loses people in
    // the first three seconds or the last ten.
    return {
      ...row,
      landingPage: mapping ? mapping.landingPage : null,
      landingPageViews,
    };
  });
}

module.exports = {
  isoDate, addDays, withTimeout, googleCredentials,
  fetchMetaInsights, fetchMetaAdDestinations, fetchClickFunnelsWeekly, fetchSheetLeads, discoverClickFunnelsPages,
  mergeDailySpend,
};
