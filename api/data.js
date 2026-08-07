const { getSupabase } = require('../lib/supabase');
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
  }));
  const leads = (leadsData || []).map(l => ({
    id: l.id,
    generatedDate: l.generated_date,
    campaign: l.campaign,
    audience: l.audience,
    creative: l.creative,
    landingPage: l.landing_page,
    attended: l.attended,
    optionsSent: l.options_sent,
    approved: l.approved,
    settled: l.settled,
  }));

  return { dailySpend, leads };
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
  return { dailySpend, leads, sources, errors };
}

module.exports = async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 98, 365);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const since = isoDate(addDays(today, -(days - 1)));
  const until = isoDate(today);

  let dailySpend = [];
  let leads = [];
  let sources = { meta: false, clickfunnels: false, sheets: false };
  let errors = {};
  let usedFallback = false;

  try {
    const fromSupabase = await readFromSupabase(since, until);
    if (fromSupabase && fromSupabase.dailySpend.length > 0) {
      dailySpend = fromSupabase.dailySpend;
      leads = fromSupabase.leads;
      sources = {
        meta: dailySpend.length > 0,
        clickfunnels: dailySpend.some(r => r.landingPageViews > 0),
        sheets: leads.length > 0,
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
    leads = live.leads;
    sources = live.sources;
    errors = { ...errors, ...live.errors };
  }

  console.log('DIAG /api/data', JSON.stringify({
    since, until, usedFallback, dailySpendCount: dailySpend.length, leadsCount: leads.length, sources, errors,
  }));

  res.status(200).json({
    sources, errors, since, until, dailySpend, leads,
    dataSource: usedFallback ? 'live-fallback' : 'supabase',
    generatedAt: new Date().toISOString(),
  });
};
