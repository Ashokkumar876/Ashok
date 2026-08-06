/**
 * Cascading dropdown: restricts "Data type" to only the values valid for
 * whatever "Parameter type" is selected on that row, matching the
 * Float/Integer/Text/Float2/Boolean/Multiple boolean values/Material/
 * Contour/Style matrix from your screenshots.
 *
 * This is the ONLY dropdown this script builds — every other column
 * (Grouping, Parameter Category, Parameter type, Default state, Composite
 * type, Value relationships, Range Type, Expression Type) is being done
 * manually by you now, per your request.
 *
 * Columns are resolved by HEADER TEXT ("Parameter type" / "Data type"),
 * not position — reordering columns is safe.
 *
 * NOTE on "Chip" display style: the Apps Script DataValidationBuilder API
 * has no method to set Chip vs Arrow display — it's a Sheets UI-only
 * toggle, and scripted control of it is still an open, unimplemented
 * feature request on Google's own issue tracker (issues 296461001 and
 * 269949809). Because Data type is cascading, this script has to rebuild
 * its validation rule every time you edit Parameter type on that row —
 * doing that will most likely reset a manually-applied Chip style back to
 * the default Arrow style on that cell. This script applies a plain Arrow
 * dropdown; if you also toggle that column to Chip by hand, expect it to
 * revert whenever Parameter type is re-edited on that row.
 *
 * Install: Extensions > Apps Script > select all > paste this file > Save,
 * then run setupDataTypeDropdown() once from the Run menu (authorize when
 * asked). After that, onEdit runs automatically, including on fill-handle
 * drags across many rows (Sheets fires onEdit once for the whole dragged
 * range, not once per row — handled explicitly below).
 */

const DATA_SHEET_NAME = 'Parameter Add';

const FIELDS = {
  paramType: ['Parameter type'],
  dataType:  ['Data type']
};

// Parameter type -> valid Data types, per your screenshot matrix.
const TYPE_DATATYPE_MAP = {
  'float':                   ['Options', 'Interval', 'Range', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'integer':                 ['Options', 'Interval', 'Range', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'text':                    ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'float2':                  ['Unlimited', 'Advanced Formula', 'Formula'],
  'boolean':                 ['Unlimited', 'Fixed Value'],
  'multiple boolean values': ['Unlimited', 'Fixed Value'],
  'material':                ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'contour':                 ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value'],
  'style':                   ['Unlimited', 'Options', 'Advanced Formula', 'Formula', 'Fixed Value']
};

function normHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[^\w ]/g, '');
}

function getHeaderMap(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const n = normHeader(h);
    if (n) map[n] = i + 1;
  });
  return map;
}

function findColumn(headerMap, aliases) {
  for (const alias of aliases) {
    const col = headerMap[normHeader(alias)];
    if (col) return col;
  }
  return null;
}

function resolveColumns(sheet) {
  const headerMap = getHeaderMap(sheet);
  return {
    paramType: findColumn(headerMap, FIELDS.paramType),
    dataType: findColumn(headerMap, FIELDS.dataType)
  };
}

function applyDataTypeValidation(sheet, row, cols) {
  const dataTypeCell = sheet.getRange(row, cols.dataType);
  const paramType = String(sheet.getRange(row, cols.paramType).getValue()).trim();

  if (!paramType) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote(null);
    return;
  }

  const validTypes = TYPE_DATATYPE_MAP[paramType.toLowerCase()];
  if (!validTypes) {
    dataTypeCell.clearDataValidations();
    dataTypeCell.setNote('Unknown Parameter type "' + paramType + '" — not in TYPE_DATATYPE_MAP in the Apps Script.');
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(validTypes, true)
    .setAllowInvalid(false)
    .build();
  dataTypeCell.setDataValidation(rule);
  dataTypeCell.setNote(null);

  // Clear a Data type value that's no longer valid for the newly-selected
  // Parameter type, rather than leave a silently-invalid combination. A
  // same-value drag (Float -> Float down many rows) never hits this, since
  // the existing value stays in validTypes.
  const current = String(dataTypeCell.getValue()).trim();
  if (current && validTypes.indexOf(current) === -1) {
    dataTypeCell.setValue('');
  }
}

/** Run once after installing (or after bulk-importing rows) to seed every existing row. */
function setupDataTypeDropdown() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + DATA_SHEET_NAME + '" not found.');

  const cols = resolveColumns(sheet);
  if (!cols.paramType || !cols.dataType) {
    throw new Error('Could not find "Parameter type" and/or "Data type" columns by header text.');
  }

  const lastRow = Math.max(sheet.getLastRow(), 2);
  for (let row = 2; row <= lastRow; row++) {
    applyDataTypeValidation(sheet, row, cols);
  }
}

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== DATA_SHEET_NAME) return;

  const startRow = Math.max(e.range.getRow(), 2);
  const endRow = e.range.getRow() + e.range.getNumRows() - 1;
  if (startRow > endRow) return;

  const cols = resolveColumns(sheet);
  if (!cols.paramType || !cols.dataType) return;

  const startCol = e.range.getColumn();
  const endCol = startCol + e.range.getNumColumns() - 1;
  const touchedParamType = cols.paramType >= startCol && cols.paramType <= endCol;
  if (!touchedParamType) return;

  for (let row = startRow; row <= endRow; row++) {
    applyDataTypeValidation(sheet, row, cols);
  }
}
