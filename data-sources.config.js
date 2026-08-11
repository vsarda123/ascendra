/*
  Joins Meta (ad-side: spend/clicks) with ClickFunnels (page-side: landing
  page views/opt-ins) and the opt-in ledger (lead-side: who booked). None of
  the three APIs knows about the others -- Meta doesn't know which
  ClickFunnels page an ad points to, ClickFunnels doesn't know which Meta
  campaign drove a visitor, and the opt-in sheet records neither. These
  mappings are what let api/data.js join them into one row per campaign.

  Not secrets -- safe to commit.
*/
module.exports = {
  // Meta campaign name -> the ClickFunnels page it sends traffic to.
  // Page IDs come from GET /api/setup-check, which lists every funnel step
  // and its page ID, or from Settings -> that page -> the ID in the URL.
  CAMPAIGN_PAGE_MAP: [
    // Landing step of the "Lead Magnet - Debt Recycling for Property
    // Investors" funnel, served publicly at dianahemmad.com.au/debt-recycling.
    { campaign: 'Debt Recycling Lead magnet campaign', clickfunnelsPageId: 23710323, landingPage: '/debt-recycling' },

    // dianahemmad.com.au/b-o-o-k-i-n-g serves a split test: pages 23502291
    // ("Booking landing page") and 23607310 (its "Test B" copy) are
    // identical and both are strict subsets of the live page, so traffic
    // divides between them and reading either alone halves the count. Both
    // campaigns below point here; the page's views are counted once and
    // apportioned between them by clicks.
    { campaign: 'Instagram Redirect Campaign', clickfunnelsPageIds: [23502291, 23607310], landingPage: '/b-o-o-k-i-n-g' },
    { campaign: 'PROS | Property Strategy | Website Leads | A', clickfunnelsPageIds: [23502291, 23607310], landingPage: '/b-o-o-k-i-n-g' },

    // Page 23693120 (Strategic Lending Framework) is deliberately unmapped:
    // no campaign currently drives it, and its 66 opt-ins arrived from
    // something other than paid Meta traffic.
  ],

  // Opt-in workbook tab -> the Meta campaign that paid for those opt-ins.
  // The workbook ("Click funnel opt ins") has one tab per lead magnet, and
  // the tab a lead landed in is the only signal of which campaign produced
  // it: the Zapier/Calendly chain never carried a campaign or UTM through.
  // Tab names are matched case-insensitively and trimmed, so the stray
  // trailing space in "Debt recycling " does not matter here.
  SHEET_TAB_CAMPAIGN_MAP: [
    { tab: 'Debt recycling', campaign: 'Debt Recycling Lead magnet campaign', landingPage: '/debt-recycling' },
    // The Meta campaign for this one still needs confirming -- leave it
    // unmapped rather than guessing, so its leads stay honestly
    // unattributed instead of being credited to the wrong campaign.
    // { tab: 'Property investing strategy', campaign: '...', landingPage: '/property-investing-strategy' },
  ],
};
