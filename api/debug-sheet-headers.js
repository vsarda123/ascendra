const { google } = require('googleapis');
const { googleCredentials } = require('../lib/sources');
const { BOOKINGS_TAB } = require('../data-sources.config');

// One-off diagnostic: which columns actually exist in the bookings sheet,
// so fetchBookings() (lib/sources.js) can be pointed at the right header
// name for a field it doesn't parse yet -- e.g. an ad-level id -- instead
// of guessing. Read-only, headers only: it deliberately never returns row
// data, so this doesn't become a second way to expose the sheet's PII
// columns (name/email/phone) beyond what fetchBookings() itself already
// reads for the sync.
module.exports = async (req, res) => {
  if (!process.env.GOOGLE_BOOKINGS_SHEET_ID) {
    res.status(500).json({ error: 'GOOGLE_BOOKINGS_SHEET_ID not configured' });
    return;
  }

  const { email, key } = googleCredentials();
  const auth = new google.auth.JWT({
    email, key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_BOOKINGS_SHEET_ID });
    const tabs = (meta.data.sheets || []).map(s => s.properties.title);

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_BOOKINGS_SHEET_ID,
      range: `'${BOOKINGS_TAB.replace(/'/g, "''")}'!A1:Z1`,
    });
    const headers = (resp.data.values || [[]])[0] || [];

    res.status(200).json({ allTabs: tabs, bookingsTab: BOOKINGS_TAB, headers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
