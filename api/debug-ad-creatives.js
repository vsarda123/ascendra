// One-off diagnostic: the actual ad copy (headline, primary text, link
// description, CTA) behind every ad name the dashboard already reports
// spend against. Neither Supabase nor the Meta Insights fields the sync job
// pulls (lib/sources.js META_INSIGHTS_FIELDS) carry creative text -- ad_name
// is a label the media buyer typed, not the words a prospect sees -- so
// this hits the Meta Marketing API's /ads edge directly for object_story_spec,
// which insights-level reporting never returns. Read-only, no write scope
// used.
module.exports = async (req, res) => {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!account || !token) {
    res.status(500).json({ error: 'META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not configured' });
    return;
  }

  const fields = [
    'id', 'name', 'effective_status',
    'campaign{name}', 'adset{name}',
    'creative{title,body,link_url,image_url,thumbnail_url,call_to_action_type,object_story_spec,asset_feed_spec{bodies,titles,descriptions,link_urls,call_to_action_types}}',
  ].join(',');
  let url = `https://graph.facebook.com/v21.0/${account}/ads?fields=${fields}&limit=200&access_token=${token}`;

  const ads = [];
  try {
    let pages = 0;
    while (url && pages < 15) {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) {
        res.status(500).json({ error: 'Meta API: ' + (j.error.message || JSON.stringify(j.error)) });
        return;
      }
      for (const ad of (j.data || [])) {
        const c = ad.creative || {};
        const spec = c.object_story_spec || {};
        const linkData = spec.link_data || {};
        const videoData = spec.video_data || {};
        // Advantage+ / "multiple text options" ads store their copy as a
        // list of candidate strings per field on asset_feed_spec instead of
        // one fixed value on object_story_spec -- Meta picks which
        // combination to actually show per-impression, so there's no single
        // "the" headline. Surface every candidate rather than picking one.
        const feed = c.asset_feed_spec || {};
        const feedTexts = (arr, key) => (Array.isArray(arr) ? arr.map(x => x[key]).filter(Boolean) : []);
        const feedBodies = feedTexts(feed.bodies, 'text');
        const feedTitles = feedTexts(feed.titles, 'text');
        const feedDescriptions = feedTexts(feed.descriptions, 'text');

        // Primary text / headline / description live in different places
        // depending on whether the creative is a link ad, a video ad, or
        // set directly on the creative object -- try each in the order
        // Meta actually populates them.
        const primaryText = linkData.message || videoData.message || c.body || null;
        const headline = linkData.name || videoData.title || c.title || null;
        const description = linkData.description || null;
        const cta = c.call_to_action_type
          || (linkData.call_to_action && linkData.call_to_action.type)
          || (videoData.call_to_action && videoData.call_to_action.type)
          || (Array.isArray(feed.call_to_action_types) && feed.call_to_action_types[0])
          || null;
        const link = c.link_url || linkData.link
          || (videoData.call_to_action && videoData.call_to_action.value && videoData.call_to_action.value.link)
          || (Array.isArray(feed.link_urls) && feed.link_urls[0] && feed.link_urls[0].website_url)
          || null;

        ads.push({
          campaign: (ad.campaign && ad.campaign.name) || null,
          adset: (ad.adset && ad.adset.name) || null,
          adName: ad.name || null,
          status: ad.effective_status || null,
          headline,
          primaryText,
          description,
          // Only populated for Advantage+ multi-text ads; empty arrays for
          // ordinary single-copy ads where headline/primaryText above are
          // already the full answer.
          advantagePlusBodies: feedBodies,
          advantagePlusTitles: feedTitles,
          advantagePlusDescriptions: feedDescriptions,
          cta,
          link,
          thumbnail: c.thumbnail_url || c.image_url || null,
        });
      }
      url = j.paging && j.paging.next ? j.paging.next : null;
      pages++;
    }
    res.status(200).json({ count: ads.length, ads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
