const { getSupabase } = require('../../lib/supabase');

// Read-only aggregation of what's actually in Supabase, grouped by creative
// (Meta's ad name). Protected the same way as sync.js -- no public data
// exposure. Not wired into the dashboard UI; this is for one-off analysis.
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

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: 'Supabase not configured.' });
    return;
  }

  const rows = await selectAll(supabase.from('daily_spend').select('*'));

  const byCreative = new Map();
  for (const r of rows) {
    const key = r.creative || '(unnamed)';
    if (!byCreative.has(key)) {
      byCreative.set(key, {
        creative: key,
        campaigns: new Set(),
        audiences: new Set(),
        spend: 0,
        clicks: 0,
        landingPageViews: 0,
        days: new Set(),
      });
    }
    const c = byCreative.get(key);
    c.campaigns.add(r.campaign);
    c.audiences.add(r.audience);
    c.spend += Number(r.spend) || 0;
    c.clicks += r.clicks || 0;
    c.landingPageViews += r.landing_page_views || 0;
    c.days.add(r.date);
  }

  const report = [...byCreative.values()].map(c => ({
    creative: c.creative,
    campaigns: [...c.campaigns],
    audiences: [...c.audiences],
    spend: Math.round(c.spend),
    clicks: c.clicks,
    cpc: c.clicks ? +(c.spend / c.clicks).toFixed(2) : null,
    landingPageViews: c.landingPageViews,
    activeDays: c.days.size,
  })).sort((a, b) => (a.cpc ?? Infinity) - (b.cpc ?? Infinity));

  res.status(200).json({
    totalRows: rows.length,
    totalSpend: Math.round(rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)),
    creativeCount: report.length,
    report,
  });
};
