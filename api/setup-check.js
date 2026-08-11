const { google } = require('googleapis');
const { discoverClickFunnelsPages, googleCredentials, fetchMetaAdDestinations } = require('../lib/sources');
const { CAMPAIGN_PAGE_MAP, SHEET_TAB_CAMPAIGN_MAP } = require('../data-sources.config');

// Setup aid for the two integrations that have credentials but aren't
// producing data yet. ClickFunnels needs page IDs that only exist in the
// account, and the Sheets connection needs to say why it returns no rows
// rather than just reporting false.
//
// Deliberately returns no lead field values, only shapes and counts -- the
// sheet holds names, emails and phone numbers, and none of that is needed
// to tell whether the connection works. Sits behind the same session gate
// as the rest of the app (middleware.js excludes only api/auth and
// api/cron).

async function checkClickFunnels() {
  if (!process.env.CLICKFUNNELS_API_TOKEN || !process.env.CLICKFUNNELS_SUBDOMAIN) {
    return { configured: false };
  }
  try {
    const raw = await discoverClickFunnelsPages();
    // The discovery helper returns whatever shape the API replied with;
    // flatten it to just what building CAMPAIGN_PAGE_MAP requires.
    const list = Array.isArray(raw.pages) ? raw.pages : (raw.pages && raw.pages.data) || [];
    return {
      configured: true,
      workspaceId: raw.resolvedWorkspaceId || null,
      workspacesStatus: raw.workspacesStatus,
      pagesStatus: raw.pagesStatus,
      pageCount: list.length,
      pages: list.slice(0, 100).map(p => ({ id: p.id, name: p.name, path: p.path || p.slug || null })),
      // Where the campaign landing pages actually live -- the workspace page
      // list is mostly theme scaffolding.
      funnelsStatus: raw.funnelsStatus,
      funnels: raw.funnels,
      // Public slugs, which is what an ad's destination URL actually uses.
      pageDetails: raw.pageDetails,
      rawIfUnrecognised: list.length ? undefined : raw,
    };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

async function checkSheet() {
  const { GOOGLE_SHEETS_PRIVATE_KEY, GOOGLE_SHEET_ID } = process.env;
  if (!GOOGLE_SHEETS_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
    return { configured: false };
  }
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A2:F';
  const { email, key } = googleCredentials();
  // Shape of the key without revealing it, so a credential that was pasted
  // in the wrong form can be identified from the response alone.
  const rawTrimmed = GOOGLE_SHEETS_PRIVATE_KEY.trim();
  const keyShape = {
    rawLooksLikeJson: rawTrimmed.startsWith('{'),
    rawLength: rawTrimmed.length,
    // A PKCS8 body base64-encodes to something starting "MII"; seeing that
    // with no header means only the wrapper is missing, not the key.
    rawStartsWithMII: rawTrimmed.startsWith('MII'),
    rawFirstChars: rawTrimmed.slice(0, 5),
    rawHasBeginAnywhere: rawTrimmed.includes('-----BEGIN'),
    resolvedLength: key.length,
    startsWithHeader: key.startsWith('-----BEGIN'),
    endsWithFooter: key.trimEnd().endsWith('-----'),
    newlineCount: (key.match(/\n/g) || []).length,
    emailResolved: Boolean(email),
  };

  try {
    const auth = new google.auth.JWT({
      email, key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    // Exchange the JWT for a token explicitly. Left implicit, a credential
    // failure surfaces later as a confusing "unregistered callers" 403 from
    // the Sheets API instead of the actual auth error.
    try {
      await auth.authorize();
    } catch (authErr) {
      return { configured: true, keyShape, serviceAccount: email, authError: authErr.message };
    }
    const sheets = google.sheets({ version: 'v4', auth });

    // Tab names are the usual culprit: the default range says 'Sheet1', and
    // a sheet whose tab was renamed rejects the range outright.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
    const tabs = (meta.data.sheets || []).map(s => s.properties.title);

    // Mirrors what fetchSheetLeads actually does now -- reads every tab and
    // locates columns by header -- so this reports the real state of the
    // connection rather than probing a range nothing uses any more.
    const perTab = [];
    for (const tab of tabs) {
      const tabRange = `'${tab.replace(/'/g, "''")}'!A1:Z`;
      try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: tabRange });
        const rows = resp.data.values || [];
        const headers = (rows[0] || []).map(h => String(h || '').trim());

        // Distinct values of the landing page column, with counts. This is
        // the only field tying an opt-in to the page that produced it, so it
        // is what lets a ClickFunnels page ID be matched to a campaign. Page
        // names are not personal data; no other column's values are read.
        const iLanding = headers.findIndex(h => h.toLowerCase().includes('landing'));
        let landingPages = null;
        if (iLanding !== -1) {
          const counts = {};
          for (const r of rows.slice(1)) {
            const v = (r[iLanding] || '').toString().trim();
            if (v) counts[v] = (counts[v] || 0) + 1;
          }
          landingPages = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([value, count]) => ({ value, count }));
        }

        perTab.push({
          tab,
          headers,
          dataRows: Math.max(0, rows.length - 1),
          landingPages,
          mappedToCampaign: (SHEET_TAB_CAMPAIGN_MAP.find(m => m.tab.trim().toLowerCase() === tab.trim().toLowerCase()) || {}).campaign || null,
        });
      } catch (tabErr) {
        perTab.push({ tab, error: tabErr.message });
      }
    }

    return {
      configured: true,
      keyShape,
      serviceAccount: email,
      spreadsheetTitle: meta.data.properties && meta.data.properties.title,
      tabs: perTab,
      totalDataRows: perTab.reduce((s, t) => s + (t.dataRows || 0), 0),
    };
  } catch (e) {
    return { configured: true, keyShape, serviceAccount: email, rangeUsed: range, error: e.message };
  }
}

// Matches each campaign's ad destination URL against the funnel pages, so
// CAMPAIGN_PAGE_MAP can be filled in from evidence rather than by guessing
// which page a campaign name sounds like it points to.
function proposeMapping(clickfunnels, destinations) {
  if (!Array.isArray(destinations) || !clickfunnels || !clickfunnels.funnels) return null;

  const pages = [];
  for (const f of clickfunnels.funnels) {
    for (const s of f.steps || []) {
      if (s.url) pages.push({ funnel: f.name, stepName: s.stepName, pageId: s.pageId, url: s.url.split('?')[0] });
    }
  }
  // Compare on path alone: the same page answers on both the workspace
  // myclickfunnels.com host and the custom dianahemmad.com.au domain.
  const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/$/, ''); } catch { return null; } };

  return destinations.map(d => {
    const matches = [];
    for (const dest of d.destinations) {
      const p = pathOf(dest.url);
      if (!p) continue;
      for (const page of pages) {
        if (pathOf(page.url) === p) matches.push({ destination: dest.url, ...page });
      }
    }
    return {
      campaign: d.campaign,
      destinations: d.destinations,
      matchedPages: matches,
      suggestion: matches.length
        ? { campaign: d.campaign, clickfunnelsPageId: matches[0].pageId, landingPage: pathOf(matches[0].url) }
        : null,
    };
  });
}

// Answers "which page is this ad pointing at" directly: pass
// ?path=/b-o-o-k-i-n-g and get the page whose published slug matches.
function findByPath(clickfunnels, wanted) {
  if (!wanted || !clickfunnels || !clickfunnels.pageDetails) return null;
  const norm = (p) => '/' + String(p || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const target = norm(wanted);

  return Object.entries(clickfunnels.pageDetails)
    .filter(([, d]) => d.currentPath && norm(d.currentPath) === target)
    .map(([pageId, d]) => ({ pageId: Number(pageId), name: d.name, currentPath: d.currentPath }));
}

module.exports = async (req, res) => {
  const [clickfunnels, sheet, destinations] = await Promise.all([
    checkClickFunnels(),
    checkSheet(),
    fetchMetaAdDestinations().catch(e => ({ error: e.message })),
  ]);

  res.status(200).json({
    clickfunnels,
    sheet,
    adDestinations: destinations,
    pathLookup: req.query && req.query.path
      ? { path: req.query.path, matches: findByPath(clickfunnels, req.query.path) }
      : null,
    proposedCampaignPageMap: proposeMapping(clickfunnels, destinations),
    campaignPageMap: { mappings: CAMPAIGN_PAGE_MAP.length, entries: CAMPAIGN_PAGE_MAP },
    checkedAt: new Date().toISOString(),
  });
};
