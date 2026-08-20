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
    'creative{title,body,link_url,image_url,thumbnail_url,call_to_action_type,object_story_spec}',
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
          || null;
        const link = c.link_url || linkData.link
          || (videoData.call_to_action && videoData.call_to_action.value && videoData.call_to_action.value.link)
          || null;

        ads.push({
          campaign: (ad.campaign && ad.campaign.name) || null,
          adset: (ad.adset && ad.adset.name) || null,
          adName: ad.name || null,
          status: ad.effective_status || null,
          headline,
          primaryText,
          description,
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
