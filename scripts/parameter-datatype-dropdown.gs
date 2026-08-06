/**
 * Cascading dropdown: restricts "Data type" (Parameter Add!F) to only the
 * values valid for whatever "Parameter type" (Parameter Add!E) is selected
 * on that row.
 *
 * The Parameter type -> Data type matrix is HARD-CODED below (TYPE_DATATYPE_MAP)
 * instead of being read from the "Parameters DropDown" tab on every edit.
 * Two reasons:
 *   1. Speed — a sheet read on every keystroke was the source of the lag.
 *   2. Correctness on drag-fill — Google Sheets fires onEdit ONCE for the
 *      whole dragged range, not once per row. The previous version only
 *      ever read e.range.getRow() (the first row of that range), so
 *      dragging Parameter type down 20 rows only applied/validated row 1 —
 *      the other 19 rows kept whatever Data type they had before, even if
 *      it was no longer valid for the new Parameter type. Fixed below by
 *      looping every row in e.range.
 *
 * Install: open the sheet > Extensions > Apps Script, paste this file's
 * contents, save. onEdit is a simple trigger — no manual trigger setup
 * needed, it fires automatically on any edit made by a human in the UI
 * (including a fill-handle drag).
 *
 * After installing, run backfillAllDataTypeDropdowns() once (Run menu in
 * the Apps Script editor) to apply the validation to any rows you already
 * filled in before the script existed.
 *
 * If you ever change the valid Data types for a Parameter type, edit
 * TYPE_DATATYPE_MAP below AND the "Parameters DropDown" tab together so
 * they stay in sync — the tab is documentation now, the script no longer
 * reads it.
 */

const DATA_SHEET_NAME = 'Parameter Add';

// Parameter Add columns (A=1) — matches the workbook's locked header order.
const COL = {
  PARAM_TYPE: 5,  // E: Parameter type
  DATA_TYPE: 6    // F: Data type
};

// Hard-coded Parameter type -> valid Data types. Keys are matched
// case-insensitively. Mirrors the userscript's own TYPE_MATRIX.
const TYPE_DATATYPE_MAP = {
  'float': ['Options', 'Interval', 'Range', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'integer': ['Options', 'Interval', 'Range', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'text': ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'float2': ['Unlimited', 'Advanced Formula', 'Formula'],
  'boolean': ['Unlimited', 'Fixed Value'],
  'multiple boolean values': ['Unlimited', 'Fixed Value'],
  'material': ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'style': ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'contour': ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value']
};

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== DATA_SHEET_NAME) return;

  // Drag-fill / paste can span many rows and/or columns in one event —
  // only react if the edited range touches the Parameter type column.
  const startCol = e.range.getColumn();
  const endCol = startCol + e.range.getNumColumns() - 1;
  if (COL.PARAM_TYPE < startCol || COL.PARAM_TYPE > endCol) return;

  const startRow = Math.max(e.range.getRow(), 2); // never row 1 (header)
  const endRow = e.range.getRow() + e.range.getNumRows() - 1;
  if (startRow > endRow) return;

  for (let row = startRow; row <= endRow; row++) {
    applyDataTypeValidation(sheet, row);
  }
}

function applyDataTypeValidation(sheet, row) {
  const paramType = String(sheet.getRange(row, COL.PARAM_TYPE).getValue()).trim();
  const dataTypeCell = sheet.getRange(row, COL.DATA_TYPE);

  if (!paramType) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote(null);
    return;
  }

  const validTypes = TYPE_DATATYPE_MAP[paramType.toLowerCase()];
  if (!validTypes) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote(
      'Unknown Parameter type "' + paramType + '" — not in TYPE_DATATYPE_MAP in the Apps Script.'
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
  // Same-value drags (Float -> Float across many rows) never hit this,
  // since the existing value is always still in validTypes.
  const current = String(dataTypeCell.getValue()).trim();
  if (current && validTypes.indexOf(current) === -1) {
    dataTypeCell.setValue('');
  }
}

/**
 * One-shot backfill: applies the correct Data type dropdown to every
 * existing row in Parameter Add, based on whatever Parameter type is
 * already there. Run this once after installing the script, and again any
 * time you bulk-paste rows in from elsewhere (paste of pre-filled values
 * still fires onEdit, but run this anyway if you ever import via a method
 * that bypasses the UI, e.g. an API-based import).
 */
function backfillAllDataTypeDropdowns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  for (let row = 2; row <= lastRow; row++) {
    applyDataTypeValidation(sheet, row);
  }
}
