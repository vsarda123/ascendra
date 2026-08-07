/*
  Joins Meta (ad-side: spend/clicks) with ClickFunnels (page-side: landing
  page views/opt-ins). The two APIs have no knowledge of each other -- Meta
  doesn't know which ClickFunnels page an ad points to, and ClickFunnels
  doesn't know which Meta campaign drove a visitor. This mapping is what
  lets api/data.js join them into one row per campaign.

  Fill in each campaign once you know its exact Meta campaign name and its
  ClickFunnels page ID (Settings -> that page -> the ID in the URL, or via
  GET /workspaces/{id}/pages). Not a secret -- safe to commit.
*/
module.exports = {
  CAMPAIGN_PAGE_MAP: [
    // { campaign: 'Rate Rise Anxiety – Retarget', clickfunnelsPageId: 12345, landingPage: '/rate-check' },
  ],
};
