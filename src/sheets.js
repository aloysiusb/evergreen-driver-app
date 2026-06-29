// sheets.js
// Wrapper around the Google Sheets API. Reads credentials from an
// environment variable (set in Render's dashboard), never from a file
// committed to the repo.

import { google } from "googleapis";

let sheetsClient = null;

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_KEY env var. Set it in Render's " +
      "Environment tab to the full contents of your service account JSON key."
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON. Paste the *entire* " +
      "contents of the key file, including the curly braces."
    );
  }
}

export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: "v4", auth: authClient });
  return sheetsClient;
}

export async function readRange(spreadsheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return res.data.values || [];
}

// Returns rows as { values: string[], rowColor: {red,green,blue}|null }
// rowColor is null when the row has no background (white/default).
export async function readRangeWithColors(spreadsheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [range],
    includeGridData: true,
    fields: 'sheets.data.rowData.values.effectiveValue,sheets.data.rowData.values.effectiveFormat.backgroundColor',
  });

  const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || [];

  return rowData.map(row => {
    const cells = row.values || [];

    const values = cells.map(c => {
      const v = c.effectiveValue;
      if (!v) return '';
      if (v.stringValue !== undefined) return v.stringValue;
      if (v.numberValue !== undefined) return String(v.numberValue);
      if (v.boolValue !== undefined) return (v.boolValue ? 'TRUE' : 'FALSE');
      return '';
    });

    // Use the first non-white background color found in the row
    let rowColor = null;
    for (const cell of cells) {
      const bg = cell.effectiveFormat?.backgroundColor;
      if (bg) {
        const r = bg.red ?? 1;
        const g = bg.green ?? 1;
        const b = bg.blue ?? 1;
        if (r < 0.95 || g < 0.95 || b < 0.95) { rowColor = bg; break; }
      }
    }

    return { values, rowColor };
  });
}

export async function writeRange(spreadsheetId, range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

export async function appendRows(spreadsheetId, range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

// Duplicates a tab within the same spreadsheet - used for the daily
// backup snapshot before drivers start editing.
export async function duplicateSheet(spreadsheetId, sourceSheetTitle, newTitle) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sourceSheet = meta.data.sheets.find(
    (s) => s.properties.title === sourceSheetTitle
  );
  if (!sourceSheet) {
    throw new Error(`Sheet "${sourceSheetTitle}" not found for backup.`);
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          duplicateSheet: {
            sourceSheetId: sourceSheet.properties.sheetId,
            insertSheetIndex: sourceSheet.properties.index + 1,
            newSheetName: newTitle,
          },
        },
      ],
    },
  });
  return res.data;
}
