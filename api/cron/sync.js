const { getSupabase } = require('../../lib/supabase');
const {
  isoDate, addDays, withTimeout,
  fetchMetaInsights, fetchClickFunnelsWeekly, fetchSheetLeads,
  fetchBookings, resolveBookingAttribution, discoverClickFunnelsPages,
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
  // Vercel Cron sends the secret as a Bearer header. The same secret is also
  // accepted as ?key= so the job can be run on demand from a browser --
  // there is otherwise no way to force a refresh without waiting for the
  // schedule, and a schema change leaves the dashboard wrong until then.
  const authHeader = req.headers['authorization'];
  const provided = authHeader === `Bearer ${process.env.CRON_SECRET}` || req.query.key === process.env.CRON_SECRET;
  if (process.env.CRON_SECRET && !provided) {
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
  let bookings = [];

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

  if (process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
    tasks.push(
      withTimeout(fetchSheetLeads(), SOURCE_TIMEOUT_MS, 'Google Sheets')
        .then((rows) => { leads = rows; sources.sheets = true; })
        .catch((e) => { errors.sheets = e.message; })
    );
  }

  // Bookings run alongside Meta/ClickFunnels/Sheets, not after them. This
  // used to await the Meta fetch first, purely to resolve utm_campaign (a
  // numeric Meta campaign id) to a name -- but that resolution is a cheap,
  // in-memory lookup (resolveBookingAttribution, below), while the fetch
  // itself is its own multi-second Sheets API round trip. Stacking that
  // sequentially after Meta, once Meta stopped failing in under a second and
  // started taking real time to answer, pushed the function past its time
  // limit and every source -- including the ones that had already
  // succeeded -- came back empty because nothing had been written yet.
  if (process.env.GOOGLE_BOOKINGS_SHEET_ID && process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
    tasks.push(
      withTimeout(fetchBookings(), SOURCE_TIMEOUT_MS, 'Bookings sheet')
        .then((rows) => { bookings = rows; sources.bookings = true; })
        .catch((e) => { errors.bookings = e.message; })
    );
  }

  await Promise.allSettled(tasks);

  const campaignIdToName = {};
  for (const r of metaRows) {
    if (r.campaignId) campaignIdToName[r.campaignId] = r.campaign;
  }
  bookings = resolveBookingAttribution(bookings, campaignIdToName);

  const dailySpend = mergeDailySpend(metaRows, cfByCampaign);

  // Meta's ad-level breakdown can have multiple distinct ads sharing the same
  // date+campaign+audience(adset)+creative(ad name) text -- e.g. two ads
  // literally both named "Feb Ad 4" in the same adset. Our table's key is
  // that combination, not the ad ID, so those collide. A single upsert can't
  // touch the same conflict key twice in one statement ("ON CONFLICT DO
  // UPDATE command cannot affect row a second time"), so collapse duplicates
  // by summing spend/clicks/views before writing.
  const SUMMED_METRICS = [
    'spend', 'clicks', 'landingPageViews', 'impressions', 'reach',
    'inlineLinkClicks', 'outboundClicks', 'videoPlays',
    'videoP25', 'videoP50', 'videoP75', 'videoP95', 'videoThruplay',
  ];
  const dedupedByKey = new Map();
  for (const r of dailySpend) {
    const key = `${r.date}|${r.campaign}|${r.audience}|${r.creative}`;
    const existing = dedupedByKey.get(key);
    if (existing) {
      // Summing reach across merged ads overstates it -- reach is unique
      // people, so two ads that reached the same person count them twice.
      // Meta only reports it per ad and gives no way to de-duplicate across
      // them, so this is an upper bound. Impressions and clicks are true
      // counts and sum exactly.
      for (const k of SUMMED_METRICS) existing[k] += r[k] || 0;
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
        impressions: r.impressions || 0,
        reach: r.reach || 0,
        inline_link_clicks: r.inlineLinkClicks || 0,
        outbound_clicks: r.outboundClicks || 0,
        video_plays: r.videoPlays || 0,
        video_p25: r.videoP25 || 0,
        video_p50: r.videoP50 || 0,
        video_p75: r.videoP75 || 0,
        video_p95: r.videoP95 || 0,
        video_thruplay: r.videoThruplay || 0,
        quality_ranking: r.qualityRanking || null,
        engagement_rate_ranking: r.engagementRateRanking || null,
        conversion_rate_ranking: r.conversionRateRanking || null,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'date,campaign,audience,creative' }
    );
    if (error) errors.supabaseWriteSpend = error.message;
  }

  // Opt-ins and bookings share the table, told apart by `kind`. A download
  // is not a lead, and cost per lead measured against downloads understates
  // the true figure by however many never book.
  const leadRows = [
    ...leads.map(l => ({
      id: l.id,
      kind: 'optin',
      generated_date: l.generatedDate,
      campaign: l.campaign,
      audience: l.audience,
      creative: l.creative,
      landing_page: l.landingPage,
      source_tab: l.sourceTab || null,
      attended: false,
      attendance_recorded: false,
      updated_at: new Date().toISOString(),
    })),
    ...bookings.map(b => ({
      id: b.id,
      kind: 'booking',
      generated_date: b.generatedDate,
      campaign: b.campaign,
      audience: b.audience,
      creative: b.creative,
      landing_page: b.landingPage,
      utm_campaign: b.utmCampaign,
      utm_medium: b.utmMedium,
      utm_source: b.utmSource,
      channel: b.channel,
      attended: b.attended,
      attendance_recorded: b.attendanceRecorded,
      updated_at: new Date().toISOString(),
    })),
  ];

  // Last line of defence on the same conflict rule: whatever the sources
  // produce, one id may appear only once per statement.
  const uniqueLeadRows = [...new Map(leadRows.map(r => [r.id, r])).values()];

  if (uniqueLeadRows.length) {
    const { error } = await supabase.from('leads').upsert(uniqueLeadRows, { onConflict: 'id' });
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
    optinCount: leads.length,
    bookingCount: bookings.length,
    bookingsAttributed: bookings.filter(b => b.campaign).length,
    bookingsWithAttendanceRecorded: bookings.filter(b => b.attendanceRecorded).length,
    cfPagesDiag,
    syncedAt: new Date().toISOString(),
  });
};
