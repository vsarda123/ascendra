const { google } = require('googleapis');
const { CAMPAIGN_PAGE_MAP } = require('../data-sources.config');

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

async function fetchSheetLeads() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A2:F';
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range });
  const rows = resp.data.values || [];

  return rows
    .map((r, i) => ({
      id: 'S' + i,
      generatedDate: normalizeSheetDate(r[0]),
      firstName: r[1] ? r[1].trim() : null,
      lastName: r[2] ? r[2].trim() : null,
      email: r[3] ? r[3].trim() : null,
      phone: r[4] ? r[4].trim() : null,
      campaign: null,
      audience: null,
      creative: null,
      landingPage: r[5] ? r[5].trim() : null,
      attended: false,
      optionsSent: false,
      approved: false,
      settled: false,
    }))
    .filter(l => l.generatedDate);
}

// TEMP diagnostic -- discovers workspace ID and page list so we can build
// the campaign-to-page mapping without manually hunting for page IDs.
async function discoverClickFunnelsPages() {
  const subdomain = process.env.CLICKFUNNELS_SUBDOMAIN;
  const token = process.env.CLICKFUNNELS_API_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  const out = {};

  const wsResp = await fetch(`https://${subdomain}.myclickfunnels.com/api/v2/workspaces`, { headers });
  out.workspacesStatus = wsResp.status;
  const wsJson = await wsResp.json().catch(() => null);
  out.workspaces = wsJson;

  const workspaceId = Array.isArray(wsJson) ? wsJson[0]?.id : (wsJson?.data?.[0]?.id || wsJson?.id);
  out.resolvedWorkspaceId = workspaceId || null;

  if (workspaceId) {
    const pagesResp = await fetch(`https://${subdomain}.myclickfunnels.com/api/v2/workspaces/${workspaceId}/pages`, { headers });
    out.pagesStatus = pagesResp.status;
    out.pages = await pagesResp.json().catch(() => null);
  }

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
    return {
      date: row.date,
      campaign: row.campaign,
      audience: row.audience,
      creative: row.creative,
      landingPage: mapping ? mapping.landingPage : null,
      spend: row.spend,
      clicks: row.clicks,
      landingPageViews,
    };
  });
}

module.exports = {
  isoDate, addDays, withTimeout,
  fetchMetaInsights, fetchClickFunnelsWeekly, fetchSheetLeads, discoverClickFunnelsPages,
  mergeDailySpend,
};
