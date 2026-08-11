const { getSupabase } = require('../lib/supabase');
const { CAMPAIGN_PAGE_MAP } = require('../data-sources.config');
const {
  isoDate, addDays, withTimeout,
  fetchMetaInsights, fetchClickFunnelsWeekly, fetchSheetLeads,
  mergeDailySpend,
} = require('../lib/sources');

// Reads from Supabase (populated by api/cron/sync.js on a schedule) instead
// of calling Meta/ClickFunnels live on every page load. That live call was
// taking 10-20+ seconds and was the one thing in common across every version
// of the dashboard hanging -- a Supabase read takes well under a second
// regardless of how slow Meta's API is being that day.
// PostgREST caps a single request at 1000 rows by default (a Supabase
// project setting) regardless of how many actually match the filter --
// it doesn't error, it just silently truncates. 1620 rows were written by
// the sync job but a plain .select() only ever returned 1000 of them. Page
// through with .range() until a page comes back short.
async function selectAll(query, pageSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function readFromSupabase(since, until) {
  const supabase = getSupabase();
  if (!supabase) return null;

  let spendData, leadsData;
  try {
    [spendData, leadsData] = await Promise.all([
      selectAll(supabase.from('daily_spend').select('*').gte('date', since).lte('date', until)),
      selectAll(supabase.from('leads').select('*').gte('generated_date', since).lte('generated_date', until)),
    ]);
  } catch (e) {
    throw new Error('Supabase read: ' + e.message);
  }

  const dailySpend = (spendData || []).map(r => ({
    date: r.date,
    campaign: r.campaign,
    audience: r.audience,
    creative: r.creative,
    landingPage: r.landing_page,
    spend: Number(r.spend) || 0,
    clicks: r.clicks || 0,
    landingPageViews: r.landing_page_views || 0,
    // Default to 0 rather than assuming the column exists: rows written
    // before supabase-migration.sql was applied have no value for these.
    impressions: r.impressions || 0,
    reach: r.reach || 0,
    inlineLinkClicks: r.inline_link_clicks || 0,
    outboundClicks: r.outbound_clicks || 0,
    videoPlays: r.video_plays || 0,
    videoP25: r.video_p25 || 0,
    videoP50: r.video_p50 || 0,
    videoP75: r.video_p75 || 0,
    videoP95: r.video_p95 || 0,
    videoThruplay: r.video_thruplay || 0,
    qualityRanking: r.quality_ranking || null,
    engagementRateRanking: r.engagement_rate_ranking || null,
    conversionRateRanking: r.conversion_rate_ranking || null,
  }));
  const mapped = (leadsData || []).map(l => ({
    id: l.id,
    kind: l.kind || 'optin',
    generatedDate: l.generated_date,
    campaign: l.campaign,
    audience: l.audience,
    creative: l.creative,
    landingPage: l.landing_page,
    sourceTab: l.source_tab || null,
    utmCampaign: l.utm_campaign || null,
    utmMedium: l.utm_medium || null,
    utmSource: l.utm_source || null,
    attended: l.attended,
    attendanceRecorded: l.attendance_recorded || false,
  }));

  // When the sync last wrote, and whether the schema it needs is actually
  // there. Every metric reading zero has the same two possible causes -- the
  // migration was not run, or the sync has not run since -- and neither is
  // visible from the dashboard without this.
  const newest = (spendData || []).reduce((max, r) => (r.updated_at > max ? r.updated_at : max), '');
  const sample = (spendData || [])[0] || {};
  const sampleLead = (leadsData || [])[0] || {};

  // Bookings are the qualified leads; opt-ins are guide downloads and a
  // separate, earlier funnel stage.
  return {
    dailySpend,
    leads: mapped.filter(l => l.kind === 'booking'),
    optins: mapped.filter(l => l.kind === 'optin'),
    freshness: {
      lastSyncedAt: newest || null,
      spendHasMetricColumns: Object.prototype.hasOwnProperty.call(sample, 'impressions'),
      leadsHaveKindColumn: Object.prototype.hasOwnProperty.call(sampleLead, 'kind'),
    },
  };
}

// Fallback used only if Supabase isn't configured yet, or has no rows for
// this range (e.g. the sync cron hasn't run yet). Same live-fetch path the
// dashboard used before Supabase existed.
async function readLive(since, until) {
  const sources = { meta: false, clickfunnels: false, sheets: false };
  const errors = {};
  let metaRows = [];
  let cfByCampaign = {};
  let leads = [];

  const SOURCE_TIMEOUT_MS = 45000;
  const tasks = [];

  if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
    tasks.push(
      withTimeout(fetchMetaInsights(since, until), SOURCE_TIMEOUT_MS, 'Meta')
        .then((rows) => { metaRows = rows; sources.meta = true; })
        .catch((e) => { errors.meta = e.message; })
    );
  }
  if (process.env.CLICKFUNNELS_API_TOKEN && process.env.CLICKFUNNELS_SUBDOMAIN) {
    tasks.push(
      withTimeout(fetchClickFunnelsWeekly(since, until), SOURCE_TIMEOUT_MS, 'ClickFunnels')
        .then((byCampaign) => { cfByCampaign = byCampaign; sources.clickfunnels = true; })
        .catch((e) => { errors.clickfunnels = e.message; })
    );
  }
  if (process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
    tasks.push(
      withTimeout(fetchSheetLeads(), SOURCE_TIMEOUT_MS, 'Google Sheets')
        .then((rows) => { leads = rows; sources.sheets = true; })
        .catch((e) => { errors.sheets = e.message; })
    );
  }

  await Promise.allSettled(tasks);
  const dailySpend = mergeDailySpend(metaRows, cfByCampaign);
  // The sheet readers carry names, emails and phone numbers so leads can be
  // de-duplicated and matched; none of that is needed to draw a dashboard.
  // The Supabase path never stores those fields, but this path returned them
  // straight to the browser. Drop them here so the response cannot carry
  // customer contact details regardless of which path served it.
  return { dailySpend, leads: leads.map(stripPii), sources, errors };
}

function stripPii(lead) {
  const { firstName, lastName, email, phone, ...safe } = lead;
  return safe;
}

module.exports = async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 98, 365);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const since = isoDate(addDays(today, -(days - 1)));
  const until = isoDate(today);

  let dailySpend = [];
  let leads = [];
  let optins = [];
  let freshness = null;
  let sources = { meta: false, clickfunnels: false, sheets: false, bookings: false };
  let errors = {};
  let usedFallback = false;

  try {
    const fromSupabase = await readFromSupabase(since, until);
    if (fromSupabase && fromSupabase.dailySpend.length > 0) {
      dailySpend = fromSupabase.dailySpend;
      leads = fromSupabase.leads;
      optins = fromSupabase.optins;
      freshness = fromSupabase.freshness;
      sources = {
        meta: dailySpend.length > 0,
        clickfunnels: dailySpend.some(r => r.landingPageViews > 0),
        sheets: optins.length > 0,
        bookings: leads.length > 0,
      };
    } else {
      usedFallback = true;
    }
  } catch (e) {
    errors.supabase = e.message;
    usedFallback = true;
  }

  if (usedFallback) {
    const live = await readLive(since, until);
    dailySpend = live.dailySpend;
    // The live path reads the opt-in workbook only; bookings come from a
    // separate sheet that the sync job joins to Meta campaign IDs.
    optins = live.leads;
    leads = [];
    sources = { ...live.sources, bookings: false };
    errors = { ...errors, ...live.errors };
  }

  console.log('DIAG /api/data', JSON.stringify({
    since, until, usedFallback,
    dailySpendCount: dailySpend.length, bookingCount: leads.length, optinCount: optins.length,
    sources, errors,
  }));

  // Which integrations have credentials at all, as booleans only -- never
  // the values. Distinguishes "connected but returning nothing" from "never
  // set up", which the sources flags alone cannot: both show up as false.
  const config = {
    meta: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
    clickfunnels: Boolean(process.env.CLICKFUNNELS_API_TOKEN && process.env.CLICKFUNNELS_SUBDOMAIN),
    sheets: Boolean(process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID),
    bookings: Boolean(process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_BOOKINGS_SHEET_ID),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    campaignPageMappings: CAMPAIGN_PAGE_MAP.length,
    // A mapping is matched on the exact campaign name Meta reports, so a
    // renamed or mistyped campaign silently maps nothing and its landing
    // page column stays empty with no error anywhere. Name the misses.
    unmatchedCampaignMappings: CAMPAIGN_PAGE_MAP
      .map(m => m.campaign)
      .filter(name => !dailySpend.some(r => r.campaign === name)),
  };

  res.status(200).json({
    sources, errors, config, freshness, since, until, dailySpend, leads, optins,
    // How much of the booking ledger can be tied to a campaign at all. A
    // cost per lead computed over attributed bookings alone is only as
    // trustworthy as this share.
    attribution: {
      bookings: leads.length,
      bookingsAttributed: leads.filter(l => l.campaign).length,
      attendanceRecorded: leads.filter(l => l.attendanceRecorded).length,
    },
    dataSource: usedFallback ? 'live-fallback' : 'supabase',
    generatedAt: new Date().toISOString(),
  });
};
