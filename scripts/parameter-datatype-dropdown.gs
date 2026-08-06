/**
 * Cascading dropdown: restricts "Data type" (Parameter Add!F) to only the
 * values valid for whatever "Parameter type" (Parameter Add!E) is selected
 * on that row, read live from the Parameters DropDown tab's matrix
 * (Parameter type in column C, its valid Data types spread across D:I).
 *
 * Install: open the sheet > Extensions > Apps Script, paste this file's
 * contents, save. onEdit is a simple trigger — no manual trigger setup
 * needed, it fires automatically on any edit made by a human in the UI.
 *
 * After installing, run backfillAllDataTypeDropdowns() once (Run menu in
 * the Apps Script editor) to apply the validation to any rows you already
 * filled in before the script existed.
 */

const DATA_SHEET_NAME = 'Parameter Add';
const LOOKUP_SHEET_NAME = 'Parameters DropDown';

// Parameter Add columns (A=1) — matches the workbook's locked header order.
const COL = {
  PARAM_TYPE: 5,  // E: Parameter type
  DATA_TYPE: 6    // F: Data type
};

// Parameters DropDown matrix — Parameter type in column C, its valid Data
// types spread across D through I (adjust END_COL if you add more columns).
const LOOKUP = {
  TYPE_COL: 3,     // C
  DATATYPE_START: 4, // D
  DATATYPE_END: 9    // I
};

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== DATA_SHEET_NAME) return;
  if (e.range.getRow() === 1) return;
  if (e.range.getColumn() !== COL.PARAM_TYPE) return;

  applyDataTypeValidation(sheet, e.range.getRow());
}

function applyDataTypeValidation(sheet, row) {
  const paramType = String(sheet.getRange(row, COL.PARAM_TYPE).getValue()).trim();
  const dataTypeCell = sheet.getRange(row, COL.DATA_TYPE);

  if (!paramType) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote(null);
    return;
  }

  const validTypes = lookupValidDataTypes(paramType);
  if (validTypes.length === 0) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote(
      'No Data type list found for Parameter type "' + paramType + '" in the ' + LOOKUP_SHEET_NAME + ' tab — add a row there first.'
    );
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(validTypes, true)
    .setAllowInvalid(false)
    .build();
  dataTypeCell.setDataValidation(rule);
  dataTypeCell.setNote(null);

  // If the row already had a Data type value that's no longer valid for the
  // newly-selected Parameter type (e.g. switched Float -> Text while Range
  // was set), clear it rather than leave a silently-invalid combination.
  const current = String(dataTypeCell.getValue()).trim();
  if (current && validTypes.indexOf(current) === -1) {
    dataTypeCell.setValue('');
  }
}

function lookupValidDataTypes(paramType) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lookupSheet = ss.getSheetByName(LOOKUP_SHEET_NAME);
  if (!lookupSheet) return [];

  const lastRow = lookupSheet.getLastRow();
  const width = LOOKUP.DATATYPE_END - LOOKUP.TYPE_COL + 1;
  const values = lookupSheet.getRange(1, LOOKUP.TYPE_COL, lastRow, width).getValues();

  for (const rowVals of values) {
    const rowType = String(rowVals[0]).trim();
    if (rowType && rowType.toLowerCase() === paramType.toLowerCase()) {
      return rowVals.slice(1).map(v => String(v).trim()).filter(v => v !== '');
    }
  }
  return [];
}

/**
 * One-shot backfill: applies the correct Data type dropdown to every
 * existing row in Parameter Add, based on whatever Parameter type is
 * already there. Run this once after installing the script, and again any
 * time you bulk-paste rows in from elsewhere (paste doesn't trigger onEdit).
 */
function backfillAllDataTypeDropdowns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  for (let row = 2; row <= lastRow; row++) {
    applyDataTypeValidation(sheet, row);
  }
}
