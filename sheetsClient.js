/**
 * sheetsClient.js
 * Google Sheets API v4 wrapper using a Service Account.
 */

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// Column letter helpers
function colLetterToIndex(letter) {
  // "A" -> 0, "Z" -> 25, "AA" -> 26
  let n = 0;
  for (const c of letter.toUpperCase()) {
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

function indexToColLetter(index) {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

class SheetsClient {
  constructor() {
    this._auth = null;
    this._sheets = null;
  }

  async _getAuth() {
    if (this._auth) return this._auth;

    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(
        'credentials.json not found. Please add your Google Service Account credentials file.'
      );
    }

    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    if (creds._comment) {
      throw new Error(
        'credentials.json is still a template. Please replace it with your real Google Service Account key.'
      );
    }

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: SCOPES,
    });

    this._auth = await auth.getClient();
    this._sheets = google.sheets({ version: 'v4', auth: this._auth });
    return this._auth;
  }

  async _ensureSheets() {
    await this._getAuth();
    return this._sheets;
  }

  /** List all sheet tab names in a spreadsheet */
  async listTabs(sheetId) {
    const sheets = await this._ensureSheets();
    const res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    return res.data.sheets.map((s) => ({
      id: s.properties.sheetId,
      title: s.properties.title,
    }));
  }

  /**
   * Read all values in a column (starting row 2).
   * @returns {Array<{row: number, value: string}>}
   */
  async readColumn(sheetId, tabName, colLetter) {
    const sheets = await this._ensureSheets();
    const range = `'${tabName}'!${colLetter}2:${colLetter}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });
    const rows = res.data.values || [];
    return rows.map((row, i) => ({
      row: i + 2, // 1-indexed, starting at row 2
      value: row[0] || '',
    }));
  }

  /**
   * Read the header row (row 1) of a tab.
   * @returns {string[]} Header values
   */
  async readHeader(sheetId, tabName) {
    const sheets = await this._ensureSheets();
    const range = `'${tabName}'!1:1`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });
    return (res.data.values && res.data.values[0]) || [];
  }

  /**
   * Auto-detect link and status columns from header.
   * @returns {{ linkCol: string|null, statusCol: string|null }}
   */
  async autoDetectColumns(sheetId, tabName) {
    const headers = await this.readHeader(sheetId, tabName);

    const LINK_KEYWORDS = ['link', 'url', 'map'];
    const STATUS_KEYWORDS = ['status', 'result', 'kết quả', 'trạng thái'];

    let linkCol = null;
    let statusCol = null;

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (!linkCol && LINK_KEYWORDS.some((k) => h.includes(k))) {
        linkCol = indexToColLetter(i);
      }
      if (!statusCol && STATUS_KEYWORDS.some((k) => h.includes(k))) {
        statusCol = indexToColLetter(i);
      }
    }

    return { linkCol, statusCol };
  }

  /**
   * Write status values to a specific column in batch.
   * @param {string} sheetId
   * @param {string} tabName
   * @param {string} colLetter  e.g. "C"
   * @param {Array<{row: number, value: string}>} updates
   */
  async writeCells(sheetId, tabName, colLetter, updates) {
    const sheets = await this._ensureSheets();

    // Build a data array indexed by row
    // Each entry is a separate ValueRange for precision (avoid overwriting other cells)
    const data = updates.map(({ row, value }) => ({
      range: `'${tabName}'!${colLetter}${row}`,
      values: [[value]],
    }));

    if (data.length === 0) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    });
  }
}

module.exports = new SheetsClient();
module.exports.colLetterToIndex = colLetterToIndex;
module.exports.indexToColLetter = indexToColLetter;
