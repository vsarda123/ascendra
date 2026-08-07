const { getSupabase } = require('../../lib/supabase');
const {
  isoDate, addDays, withTimeout,
  fetchMetaInsights, fetchClickFunnelsWeekly, fetchSheetLeads, discoverClickFunnelsPages,
  mergeDailySpend,
} = require('../../lib/sources');

// Pulls Meta + ClickFunnels + Sheets and writes the result into Supabase.
// Runs on a schedule (see vercel.json crons) instead of on every page load,
// so the dashboard itself never has to wait on Meta's slow Insights API --
// it just reads whatever this last wrote.
module.exports = async (req, res) => {
  // Vercel Cron sends this header automatically when CRON_SECRET is set as
  // an env var; without this check anyone could hit this URL and burn
  // through Meta's rate limit.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured yet (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' });
    return;
  }

  const days = 98;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const since = isoDate(addDays(today, -(days - 1)));
  const until = isoDate(today);

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

  // Meta's ad-level breakdown can have multiple distinct ads sharing the same
  // date+campaign+audience(adset)+creative(ad name) text -- e.g. two ads
  // literally both named "Feb Ad 4" in the same adset. Our table's key is
  // that combination, not the ad ID, so those collide. A single upsert can't
  // touch the same conflict key twice in one statement ("ON CONFLICT DO
  // UPDATE command cannot affect row a second time"), so collapse duplicates
  // by summing spend/clicks/views before writing.
  const dedupedByKey = new Map();
  for (const r of dailySpend) {
    const key = `${r.date}|${r.campaign}|${r.audience}|${r.creative}`;
    const existing = dedupedByKey.get(key);
    if (existing) {
      existing.spend += r.spend;
      existing.clicks += r.clicks;
      existing.landingPageViews += r.landingPageViews;
    } else {
      dedupedByKey.set(key, { ...r });
    }
  }
  const dedupedDailySpend = [...dedupedByKey.values()];

  if (dedupedDailySpend.length) {
    const { error } = await supabase.from('daily_spend').upsert(
      dedupedDailySpend.map(r => ({
        date: r.date,
        campaign: r.campaign,
        audience: r.audience,
        creative: r.creative,
        landing_page: r.landingPage,
        spend: r.spend,
        clicks: r.clicks,
        landing_page_views: r.landingPageViews,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'date,campaign,audience,creative' }
    );
    if (error) errors.supabaseWriteSpend = error.message;
  }

  if (leads.length) {
    const { error } = await supabase.from('leads').upsert(
      leads.map(l => ({
        id: l.id,
        generated_date: l.generatedDate,
        campaign: l.campaign,
        audience: l.audience,
        creative: l.creative,
        landing_page: l.landingPage,
        attended: l.attended,
        options_sent: l.optionsSent,
        approved: l.approved,
        settled: l.settled,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'id' }
    );
    if (error) errors.supabaseWriteLeads = error.message;
  }

  let cfPagesDiag = null;
  if (process.env.CLICKFUNNELS_API_TOKEN && process.env.CLICKFUNNELS_SUBDOMAIN) {
    try {
      cfPagesDiag = await discoverClickFunnelsPages();
    } catch (e) {
      cfPagesDiag = { error: e.message };
    }
  }

  res.status(200).json({
    ok: true,
    sources,
    errors,
    dailySpendCount: dedupedDailySpend.length,
    leadsCount: leads.length,
    cfPagesDiag,
    syncedAt: new Date().toISOString(),
  });
};
