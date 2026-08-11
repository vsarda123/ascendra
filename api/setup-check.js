const { google } = require('googleapis');
const { discoverClickFunnelsPages } = require('../lib/sources');
const { CAMPAIGN_PAGE_MAP } = require('../data-sources.config');

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
      rawIfUnrecognised: list.length ? undefined : raw,
    };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

async function checkSheet() {
  const { GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY, GOOGLE_SHEET_ID } = process.env;
  if (!GOOGLE_SHEETS_CLIENT_EMAIL || !GOOGLE_SHEETS_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
    return { configured: false };
  }
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A2:F';
  const key = GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n');
  // Shape of the key without revealing it. "Unregistered callers" means the
  // request carried no credentials, which is what happens when the key never
  // produced a usable token -- almost always because the env var was pasted
  // with surrounding quotes or with its newlines flattened.
  const keyShape = {
    length: key.length,
    startsWithHeader: key.startsWith('-----BEGIN'),
    endsWithFooter: key.trimEnd().endsWith('-----'),
    newlineCount: (key.match(/\n/g) || []).length,
    looksQuoteWrapped: /^["']/.test(GOOGLE_SHEETS_PRIVATE_KEY.trim()),
  };

  try {
    const auth = new google.auth.JWT(
      GOOGLE_SHEETS_CLIENT_EMAIL, null, key,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    // Exchange the JWT for a token explicitly. Left implicit, a credential
    // failure surfaces later as a confusing "unregistered callers" 403 from
    // the Sheets API instead of the actual auth error.
    try {
      await auth.authorize();
    } catch (authErr) {
      return { configured: true, keyShape, serviceAccount: GOOGLE_SHEETS_CLIENT_EMAIL, authError: authErr.message };
    }
    const sheets = google.sheets({ version: 'v4', auth });

    // Tab names are the usual culprit: the default range says 'Sheet1', and
    // a sheet whose tab was renamed returns an error rather than rows.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
    const tabs = (meta.data.sheets || []).map(s => s.properties.title);

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
    const rows = resp.data.values || [];
    return {
      configured: true,
      keyShape,
      serviceAccount: GOOGLE_SHEETS_CLIENT_EMAIL,
      spreadsheetTitle: meta.data.properties && meta.data.properties.title,
      tabs,
      rangeUsed: range,
      rowCount: rows.length,
      columnCounts: [...new Set(rows.slice(0, 50).map(r => r.length))],
      firstRowShape: rows[0] ? rows[0].map(c => (c ? String(c).slice(0, 3) + '...' : '(empty)')) : null,
    };
  } catch (e) {
    return { configured: true, keyShape, serviceAccount: GOOGLE_SHEETS_CLIENT_EMAIL, rangeUsed: range, error: e.message };
  }
}

module.exports = async (req, res) => {
  const [clickfunnels, sheet] = await Promise.all([checkClickFunnels(), checkSheet()]);
  res.status(200).json({
    clickfunnels,
    sheet,
    campaignPageMap: { mappings: CAMPAIGN_PAGE_MAP.length, entries: CAMPAIGN_PAGE_MAP },
    checkedAt: new Date().toISOString(),
  });
};
