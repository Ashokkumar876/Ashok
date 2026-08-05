/**
 * Auto-fills "Global Parameter ID" on the "Parameter Add-Edit" tab whenever
 * "Parameter Category" is set to "Global" for a row, by matching that row's
 * "Reference name" against the "Global Parameters" reference tab.
 *
 * Install: open the workbook in Google Sheets > Extensions > Apps Script,
 * paste this file's contents, save, then reload the spreadsheet tab so the
 * trigger picks it up (no separate trigger setup needed — onEdit is a
 * simple installable-by-default trigger for edits made by a human in the UI).
 */

const DATA_SHEET_NAME = 'Parameter Add-Edit';
const LOOKUP_SHEET_NAME = 'Global Parameters';

const COL = {
  REFERENCE_NAME: 2,
  NAME: 3,
  GLOBAL_ID: 20,
  CATEGORY: 21
};

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== DATA_SHEET_NAME) return;
  if (e.range.getRow() === 1) return;

  const editedCol = e.range.getColumn();
  if (editedCol !== COL.CATEGORY && editedCol !== COL.REFERENCE_NAME) return;

  const row = e.range.getRow();
  const category = sheet.getRange(row, COL.CATEGORY).getValue();

  if (String(category).trim() !== 'Global') {
    return;
  }

  const refName = String(sheet.getRange(row, COL.REFERENCE_NAME).getValue()).trim();
  if (!refName) return;

  const match = lookupGlobalParameter(refName);
  const idCell = sheet.getRange(row, COL.GLOBAL_ID);

  if (!match) {
    idCell.setValue('');
    idCell.setNote('No match found in "Global Parameters" for Reference name "' + refName + '". Add it there first.');
    idCell.setBackground('#FFF1F0');
    return;
  }

  idCell.setValue(match.id);
  idCell.setNote('Auto-filled from "Global Parameters" (' + match.displayName + ').');
  idCell.setBackground(null);

  const nameCell = sheet.getRange(row, COL.NAME);
  if (!String(nameCell.getValue()).trim()) {
    nameCell.setValue(match.displayName);
  }
}

function lookupGlobalParameter(refName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lookupSheet = ss.getSheetByName(LOOKUP_SHEET_NAME);
  if (!lookupSheet) return null;

  const values = lookupSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const rowRefName = String(values[i][0]).trim();
    if (rowRefName && rowRefName.toLowerCase() === refName.toLowerCase()) {
      return { id: values[i][1], displayName: values[i][2] };
    }
  }
  return null;
}

/**
 * Manual sweep: run this once from the Apps Script editor (Run >
 * fillAllGlobalIds) to backfill every existing "Global" row in one pass,
 * instead of relying only on the onEdit trigger going forward.
 */
function fillAllGlobalIds() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = range.getValues();

  for (let i = 0; i < values.length; i++) {
    const row = i + 2;
    const category = String(values[i][COL.CATEGORY - 1]).trim();
    if (category !== 'Global') continue;

    const refName = String(values[i][COL.REFERENCE_NAME - 1]).trim();
    if (!refName) continue;

    const match = lookupGlobalParameter(refName);
    const idCell = sheet.getRange(row, COL.GLOBAL_ID);
    if (match) {
      idCell.setValue(match.id);
      idCell.setBackground(null);
    } else {
      idCell.setBackground('#FFF1F0');
      idCell.setNote('No match found in "Global Parameters" for Reference name "' + refName + '".');
    }
  }
}
