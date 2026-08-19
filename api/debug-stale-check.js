const { fetchBookings } = require('../lib/sources');
const { getSupabase } = require('../lib/supabase');

// One-off diagnostic: for 11-12 Aug specifically, list the booking ids the
// live sheet produces right now versus what's actually stored in Supabase
// for those dates. sync.js's stale-row deletion (added after the ghost
// rows on these two dates were found) should have made these identical --
// this shows directly whether that ran, and if not, why.
module.exports = async (req, res) => {
  try {
    const liveBookings = await fetchBookings();
    const liveForDates = liveBookings.filter(b => b.generatedDate === '2026-08-11' || b.generatedDate === '2026-08-12');
    const liveIds = liveForDates.map(b => b.id).sort();

    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: 'Supabase not configured' });
      return;
    }
    const { data, error } = await supabase
      .from('leads')
      .select('id, generated_date, updated_at')
      .eq('kind', 'booking')
      .in('generated_date', ['2026-08-11', '2026-08-12']);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const supabaseIds = data.map(r => r.id).sort();
    const inSupabaseNotLive = supabaseIds.filter(id => !liveIds.includes(id));
    const inLiveNotSupabase = liveIds.filter(id => !supabaseIds.includes(id));

    res.status(200).json({
      liveSheetCount: liveIds.length,
      supabaseCount: supabaseIds.length,
      liveIds,
      supabaseRows: data,
      staleInSupabaseOnly: inSupabaseNotLive,
      missingFromSupabase: inLiveNotSupabase,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
};
