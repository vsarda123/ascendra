const { google } = require('googleapis');
const { googleCredentials, findColumn, normalizeSheetDate, BOOKINGS_TAB } = require('../lib/sources');

// One-off diagnostic: dump every bookings-sheet row whose parsed Event Date
// falls in August 2026, alongside its literal spreadsheet row number, so a
// row-range count read straight off the sheet ("rows 304 to 348") can be
// checked directly against what fetchBookings() -> the dashboard actually
// counts for the month. Uses the exact same findColumn/normalizeSheetDate
// fetchBookings() uses, not a re-implementation, so this can't drift from
// what's really being counted. Read-only; returns row number, Name and the
// date fields only -- not email/phone -- since the row number plus Name is
// enough to locate the row by eye.
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
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_BOOKINGS_SHEET_ID,
      range: `'${BOOKINGS_TAB.replace(/'/g, "''")}'!A1:Z`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) {
      res.status(200).json({ totalSheetRows: 0, augustRows: [] });
      return;
    }

    const headers = rows[0];
    const iDate = findColumn(headers, ['event date', 'date', 'booked', 'timestamp']);
    const iName = findColumn(headers, ['name']);

    const augustRows = [];
    rows.slice(1).forEach((r, i) => {
      const generatedDate = normalizeSheetDate(r[iDate]);
      // +2: row 1 is the header, rows.slice(1) index 0 is spreadsheet row 2.
      const sheetRow = i + 2;
      if (generatedDate && generatedDate >= '2026-08-01' && generatedDate <= '2026-08-31') {
        augustRows.push({
          sheetRow,
          name: iName !== -1 ? r[iName] || null : null,
          rawEventDate: r[iDate] || null,
          parsedGeneratedDate: generatedDate,
        });
      }
    });

    res.status(200).json({
      totalSheetRows: rows.length - 1,
      augustCount: augustRows.length,
      firstSheetRow: augustRows[0] ? augustRows[0].sheetRow : null,
      lastSheetRow: augustRows.length ? augustRows[augustRows.length - 1].sheetRow : null,
      augustRows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
