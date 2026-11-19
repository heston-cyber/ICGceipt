/**
 * ICGceipt → ICG Sheet
 *
 * Paste this into the ICG Sheet: Extensions › Apps Script (replace everything in Code.gs), then:
 *   1. Run `makeSecret` once (approve the permissions). Copy the secret from the log
 *      into Convex › icgceipt › Production › Settings › Environment Variables as ICG_SHEET_SECRET.
 *   2. Deploy › New deployment › Web app · Execute as: Me · Who has access: Anyone.
 *      Copy the web app URL into Convex as ICG_SHEET_URL.
 *
 * Each sent receipt becomes one row on the "Receipts" tab (made if missing). The photo is saved
 * into a Drive folder "ICGceipt photos" next to this Sheet, and the row links to it.
 * Sending the same receipt number again updates its row instead of adding a second one.
 */

var TAB = "Receipts";
var FOLDER = "ICGceipt photos";

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!secret || body.secret !== secret) return reply({ ok: false, error: "Wrong or missing secret" });
    var row = body.row || {};
    if (!row["Receipt #"]) return reply({ ok: false, error: "No receipt number" });

    var link = "";
    if (body.photoUrl) {
      try {
        link = savePhoto(body.photoUrl, body.photoName || row["Receipt #"] + ".jpg");
      } catch (err) {
        link = body.photoUrl; // fall back to the app's own link
      }
    }
    row["Photo"] = link;
    writeRow(row);
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

function writeRow(row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  var keys = Object.keys(row);
  var headers = sh.getLastRow() ? sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0] : [];
  if (!headers.length || headers.every(function (h) { return h === ""; })) headers = [];
  keys.forEach(function (k) { if (headers.indexOf(k) < 0) headers.push(k); });
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  sh.setFrozenRows(1);

  var values = headers.map(function (h) {
    var v = row[h];
    if (h === "Photo" && v) return '=HYPERLINK("' + String(v).replace(/"/g, "") + '","photo")';
    return v === undefined || v === null ? "" : v;
  });

  // Same receipt number already there → update that row.
  var numCol = headers.indexOf("Receipt #") + 1;
  var target = sh.getLastRow() + 1;
  if (sh.getLastRow() > 1) {
    var nums = sh.getRange(2, numCol, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < nums.length; i++) if (nums[i][0] === row["Receipt #"]) { target = i + 2; break; }
  }
  sh.getRange(target, 1, 1, values.length).setValues([values]);
  ["Subtotal", "Tax", "Tip", "Total"].forEach(function (h) {
    var c = headers.indexOf(h) + 1;
    if (c > 0) sh.getRange(target, c).setNumberFormat("$#,##0.00");
  });
}

function savePhoto(url, name) {
  var blob = UrlFetchApp.fetch(url).getBlob().setName(name);
  var parent = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
  var base = parent.hasNext() ? parent.next() : DriveApp.getRootFolder();
  var it = base.getFoldersByName(FOLDER);
  var folder = it.hasNext() ? it.next() : base.createFolder(FOLDER);
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  return folder.createFile(blob).getUrl();
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor. Makes the shared secret and shows it in the log (View › Logs). */
function makeSecret() {
  var s = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("SECRET", s);
  // Touch Drive and UrlFetch so their permissions are approved now, not on the first receipt.
  DriveApp.getRootFolder();
  try { UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true }); } catch (e) {}
  Logger.log("ICG_SHEET_SECRET = " + s);
}

/** Optional: run from the editor to check the Sheet side works (adds a TEST row; delete it after). */
function testRow() {
  writeRow({ "Receipt #": "TEST-0000", "Sent": new Date().toLocaleString(), "Vendor": "Test", "Total": 1.23 });
}
