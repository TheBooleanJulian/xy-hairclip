/**
 * xy-hairclip: Apps Script web app bound to the hairclip Google Sheet.
 *
 * The Worker at xy-hairclip.xymiku39.com is the only intended caller. Every
 * request carries the shared TOKEN (Script Properties), so knowing the web app
 * URL alone is not enough to read or write.
 *
 * Sheet layout (tab gid 0, "Sheet1"): A = ID (1-39), B = Names, C = Paid,
 * D = Collected. A number is taken when its Names cell is not empty. This
 * script only ever writes to an empty Names cell and never touches Paid,
 * Collected or any other column. Each claim is also appended to a
 * "Claims log" tab (created on first claim) with a timestamp.
 *
 * Setup and redeploy steps: see README.md in the repo.
 */

var SHEET_GID = 0;
var HEADER_ROWS = 1;
var ID_COL = 1; // A
var NAME_COL = 2; // B, must stay directly right of ID_COL
var TOTAL = 39;
var NAME_MAX = 40;
var LOG_SHEET = 'Claims log';

function doGet() {
  // Health check only; no data without the token.
  return out_({ ok: true, service: 'xy-hairclip' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'bad_request' });
  }
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || req.token !== token) return out_({ ok: false, error: 'unauthorised' });

  if (req.action === 'list') return out_({ ok: true, slots: list_() });
  if (req.action === 'claim') return out_(claim_(Number(req.id), String(req.name || '')));
  return out_({ ok: false, error: 'bad_request' });
}

function list_() {
  return rows_()
    .filter(function (r) { return /^\d+$/.test(r[0].trim()); })
    .map(function (r) { return { id: Number(r[0].trim()), name: r[1].trim() }; });
}

function claim_(id, name) {
  name = name.replace(/\s+/g, ' ').trim();
  if (!(id >= 1 && id <= TOTAL) || Math.floor(id) !== id || !name || name.length > NAME_MAX) {
    return { ok: false, error: 'bad_request' };
  }

  // One claim at a time, so two people can never both get the same number.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  try {
    var rows = rows_();
    var index = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0].trim() === String(id)) { index = i; break; }
    }
    if (index < 0) return { ok: false, error: 'not_found' };
    if (rows[index][1].trim() !== '') return { ok: false, error: 'taken' };

    var safe = asText_(name);
    sheet_().getRange(HEADER_ROWS + 1 + index, NAME_COL).setValue(safe);
    log_(id, safe);
    SpreadsheetApp.flush();
    return { ok: true, id: id, name: name };
  } finally {
    lock.releaseLock();
  }
}

function rows_() {
  var sheet = sheet_();
  var count = sheet.getLastRow() - HEADER_ROWS;
  if (count < 1) return [];
  return sheet.getRange(HEADER_ROWS + 1, ID_COL, count, NAME_COL - ID_COL + 1).getDisplayValues();
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetById(SHEET_GID) || ss.getSheets()[0];
}

function log_(id, safeName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET, ss.getSheets().length);
  if (log.getLastRow() === 0) log.appendRow(['Claimed at', 'ID', 'Name']);
  log.appendRow([new Date(), id, safeName]);
}

// A leading apostrophe stops Sheets from treating input like "=..." as a
// formula or "0012" as a number; it is hidden in the cell.
function asText_(value) {
  return "'" + value;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
