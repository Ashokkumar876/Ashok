/**
 * Parameter Add tools:
 *   (1) cascading Data type dropdown
 *   (2) full pre-validation with color-coded highlighting, ported 1:1 from
 *       the Tampermonkey batch-update script's validateParamEditRows() so
 *       "red" here means the exact same thing as "would block Run" there
 *   (3) live "which fields do I need to fill" highlighting — as soon as
 *       you pick a Parameter type + Data type (and Composite type / Range
 *       Type / Expression Type where relevant), every field that combo
 *       requires and is still empty lights up blue, and clears itself the
 *       moment you fill it in
 *
 * This ONE file replaces any previous version — paste over the whole
 * script project (all three features share column-resolution helpers and
 * there can only be one onEdit/onOpen per project, so they must live
 * together).
 *
 * ---------------------------------------------------------------------
 * COLORS
 * ---------------------------------------------------------------------
 * RED   (#f4c7c3) — hard error. Ported directly from an addErr() call in
 *         the userscript — if you ran this row through the batch update
 *         today, it would fail pre-validation there too. Set only by
 *         Validate Sheet.
 * YELLOW (#fce8b2) — format/style warning. The userscript still accepts
 *         these (it trims whitespace and lowercases enum comparisons
 *         before checking), but they're messy and worth cleaning up:
 *           - leading/trailing whitespace in a cell
 *           - an enum value (Select/Condition, Value/Formula, Range/
 *             Options, Outside/Within, Reference/Condition, Global/Local,
 *             a Parameter type or Data type name) that matches case-
 *             insensitively but not in the standard casing
 *         Set only by Validate Sheet.
 * BLUE  (#c9daf8) — live "needs a value" hint, set automatically by
 *         onEdit as you type. Not a correctness check — just marks which
 *         cells matter for your current Parameter type / Data type combo
 *         and are still blank. Clears itself once filled, and never
 *         overwrites a red/yellow cell (Validate Sheet owns those).
 * Red and yellow match Sheets' own built-in "Format cells if" presets so
 * they look native; blue is a separate, deliberately different hue so the
 * three meanings never get confused at a glance.
 *
 * ---------------------------------------------------------------------
 * USE
 * ---------------------------------------------------------------------
 * Install: Extensions > Apps Script > select all > paste this file >
 * Save. Reload the spreadsheet tab (custom menus only appear after a
 * fresh load, or Run > onOpen once from the Apps Script editor).
 *
 * A "Parameter Tools" menu appears with:
 *   - Validate Sheet (Highlight Errors)      — runs the full red/yellow check
 *   - Clear Validation Highlights            — wipes backgrounds/notes
 *   - Rebuild Data Type Dropdown             — re-seeds the cascading list
 *   - Highlight Required Fields (All Rows)   — backfills blue hints on
 *     rows you filled in before installing (new edits get it live)
 *
 * Validate Sheet resets the ENTIRE data range's background color before
 * reapplying highlights — don't use cell background color in this sheet
 * for anything else, it'll get cleared on every validate run. It also
 * writes/refreshes a "Validation Log" tab listing every issue with row,
 * column, model serial, parameter name, and message — same information
 * the Tampermonkey script's "Download Format Errors" button gives you,
 * just live in the sheet instead of a CSV.
 */

const DATA_SHEET_NAME = 'Parameter Add';
const COLOR_ERROR = '#f4c7c3';
const COLOR_WARNING = '#fce8b2';
// Light blue — "this field matters for the Parameter type / Data type you
// just picked, and it's currently empty." Distinct from red/yellow on
// purpose: it's live-as-you-type guidance, not a correctness check. Once
// you fill the cell it clears itself; it never overwrites a cell already
// colored red/yellow by Validate Sheet (those are left for Validate Sheet /
// Clear Validation Highlights to manage).
const COLOR_REQUIRED = '#c9daf8';

// Header text this script looks for -> internal key. Matched case- and
// whitespace-insensitively via normHeader(). First matching alias wins.
const FIELDS = {
  serial:              ['Product serial number', 'Model ID', 'Serial'],
  paramCategory:       ['Parameter Category'],
  globalId:            ['Global Parameter ID', 'Global ID'],
  grouping:            ['Grouping', 'Group'],
  paramType:           ['Parameter type'],
  dataType:            ['Data type'],
  displayName:         ['Display Name'],
  paramName:           ['Parameter Name'],
  value:               ['Value'],
  min:                 ['Minimum', 'Min'],
  max:                 ['Maximum', 'Max'],
  options:             ['Options', 'Recommends'],
  expression:          ['Expression', 'Formula Expression'],
  hideCondition:       ['Hide condition'],
  lockedCondition:     ['Locked condition', 'Lock'],
  defaultState:        ['Default state'],
  imosOutputCondition: ['IMOS Output Condition'],
  compositeType:       ['Composite type', 'Composite'],
  valueRelationship:   ['Value relationships', 'Value relationship'],
  materialRange:       ['Range Type', 'Material Range'],
  expressionType:      ['Expression Type']
};

const PARAM_TYPE_CANONICAL = ['Float', 'Float2', 'Integer', 'Text', 'Boolean', 'Multiple boolean values', 'Material', 'Contour', 'Style'];

// Parameter type -> valid Data types. Mirrors the userscript's TYPE_MATRIX.
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
const ASSET_TYPES = ['material', 'contour', 'style'];

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
  const cols = {};
  for (const key in FIELDS) {
    cols[key] = findColumn(headerMap, FIELDS[key]);
  }
  return cols;
}

function checkParens(str) {
  const open = (str.match(/\(/g) || []).length;
  const close = (str.match(/\)/g) || []).length;
  return open === close;
}

// =========================================================================
// MENU
// =========================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Parameter Tools')
    .addItem('Validate Sheet (Highlight Errors)', 'validateParameterSheet')
    .addItem('Clear Validation Highlights', 'clearValidationHighlights')
    .addItem('Rebuild Data Type Dropdown', 'setupDataTypeDropdown')
    .addItem('Highlight Required Fields (All Rows)', 'highlightRequiredFieldsAll')
    .addToUi();
}

// =========================================================================
// CASCADING DATA TYPE DROPDOWN
// =========================================================================
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

  const current = String(dataTypeCell.getValue()).trim();
  if (current && validTypes.indexOf(current) === -1) {
    dataTypeCell.setValue('');
  }
}

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

// =========================================================================
// LIVE "WHICH FIELDS DO I NEED TO FILL" HIGHLIGHTING
// =========================================================================
// Mirrors the exact same "if (!field) ..." requiredness rules used inside
// validateParameterSheet() below (min/max for Range/Interval, Composite
// type + Value relationships for non-asset Advanced Formula, Range Type
// for asset Options/Advanced Formula, Expression for Formula/Advanced
// Formula, Options when the combo routes through Options, etc.) — so the
// live blue hint and the red error you'd get from Validate Sheet always
// agree on what counts as required.
function computeRequiredKeys(ctx) {
  const pType = ctx.pType, dType = ctx.dType, compositeType = ctx.compositeType,
        materialRange = ctx.materialRange, expressionType = ctx.expressionType,
        isGlobalRow = ctx.isGlobalRow;

  const req = {};
  req.serial = true; req.paramName = true; req.displayName = true; req.grouping = true;
  if (isGlobalRow) return req;

  req.paramType = true;
  req.dataType = true;
  if (!pType || !dType) return req;

  const isAsset = ASSET_TYPES.indexOf(pType) !== -1;

  if (!isAsset && (dType === 'range' || dType === 'interval')) {
    req.min = true; req.max = true;
  }
  if (!isAsset && dType === 'advanced formula') {
    req.compositeType = true;
    req.valueRelationship = true;
    if (compositeType === 'range') { req.min = true; req.max = true; }
    if (compositeType === 'options') req.options = true;
    req.expression = true;
  }
  if (isAsset && (dType === 'options' || dType === 'advanced formula')) {
    req.materialRange = true;
  }
  if (isAsset && (dType === 'formula' || dType === 'advanced formula')) {
    req.expressionType = true;
  }
  if (dType === 'advanced formula') {
    req.defaultState = true;
  }
  if (dType === 'formula') {
    req.expression = true;
  }
  if (isAsset && dType === 'advanced formula' && expressionType) {
    req.expression = true;
  }
  if (!isAsset && dType === 'options') {
    req.options = true;
  }
  if (isAsset) {
    const usesLink = dType === 'options' || (dType === 'advanced formula' && materialRange);
    if (usesLink) req.options = true;
  }
  return req;
}

const REQUIRED_MANAGED_KEYS = ['serial', 'paramName', 'displayName', 'grouping', 'paramType', 'dataType',
  'min', 'max', 'compositeType', 'valueRelationship', 'materialRange', 'expressionType', 'defaultState',
  'expression', 'options'];

function applyRequiredHighlight(sheet, row, cols, lastCol) {
  lastCol = lastCol || sheet.getLastColumn();
  const rowRange = sheet.getRange(row, 1, 1, lastCol);
  const values = rowRange.getValues()[0];
  const backgrounds = rowRange.getBackgrounds()[0];

  function val(key) {
    const col = cols[key];
    if (!col) return '';
    const v = values[col - 1];
    return (v === null || v === undefined) ? '' : String(v).trim();
  }

  const paramCategory = val('paramCategory');
  const globalId = val('globalId');
  const isGlobalRow = paramCategory.toLowerCase() === 'global' || !!globalId;

  const required = computeRequiredKeys({
    pType: val('paramType').toLowerCase(),
    dType: val('dataType').toLowerCase(),
    compositeType: val('compositeType').toLowerCase(),
    materialRange: val('materialRange').toLowerCase(),
    expressionType: val('expressionType').toLowerCase(),
    isGlobalRow: isGlobalRow
  });

  let changed = false;
  REQUIRED_MANAGED_KEYS.forEach(function (key) {
    const col = cols[key];
    if (!col) return;
    const i = col - 1;
    const currentBg = backgrounds[i] || '#ffffff';
    if (currentBg !== '#ffffff' && currentBg !== COLOR_REQUIRED) return; // owned by Validate Sheet — leave alone

    const isEmpty = val(key) === '';
    if (required[key] && isEmpty) {
      if (currentBg !== COLOR_REQUIRED) { backgrounds[i] = COLOR_REQUIRED; changed = true; }
    } else if (currentBg === COLOR_REQUIRED) {
      backgrounds[i] = '#ffffff';
      changed = true;
    }
  });

  if (changed) rowRange.setBackgrounds([backgrounds]);
}

/** Run once to backfill live required-field highlighting on rows that already have data. */
function highlightRequiredFieldsAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + DATA_SHEET_NAME + '" not found.');
  const cols = resolveColumns(sheet);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return;
  for (let row = 2; row <= lastRow; row++) {
    applyRequiredHighlight(sheet, row, cols, lastCol);
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
  const lastCol = sheet.getLastColumn();

  for (let row = startRow; row <= endRow; row++) {
    if (touchedParamType) applyDataTypeValidation(sheet, row, cols);
    applyRequiredHighlight(sheet, row, cols, lastCol);
  }
}

// =========================================================================
// PRE-VALIDATION + COLOR HIGHLIGHTING
// (ported 1:1 from the userscript's validateParamEditHeaders/Rows)
// =========================================================================
function validateParameterSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  const ui = SpreadsheetApp.getUi();
  if (!sheet) { ui.alert('Sheet "' + DATA_SHEET_NAME + '" not found.'); return; }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) { ui.alert('No data rows to validate.'); return; }

  const cols = resolveColumns(sheet);

  const requiredCols = { serial: 'Product serial number', paramName: 'Parameter Name', displayName: 'Display Name', grouping: 'Grouping' };
  const missing = Object.keys(requiredCols).filter(k => !cols[k]);
  if (missing.length > 0) {
    ui.alert('Missing required column(s): ' + missing.map(k => requiredCols[k]).join(', ') + '. Add them before validating.');
    return;
  }

  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const issues = []; // {row, col, severity, msg, serial, refName}

  function field(r, rowNum, colKey) {
    const col = cols[colKey];
    if (!col) return '';
    const raw = data[r][col - 1];
    const str = (raw === null || raw === undefined) ? '' : String(raw);
    const trimmed = str.trim();
    if (str !== trimmed && trimmed !== '') {
      issues.push({ row: rowNum, col: col, severity: 'warning', msg: 'Leading/trailing whitespace — values are trimmed automatically so this still works, but tidy it up if you can.' });
    }
    return trimmed;
  }
  function err(rowNum, colKey, msg, serial, refName) {
    const col = cols[colKey];
    if (!col) return;
    issues.push({ row: rowNum, col: col, severity: 'error', msg: msg, serial: serial || '', refName: refName || '' });
  }
  function warn(rowNum, colKey, msg, serial, refName) {
    const col = cols[colKey];
    if (!col) return;
    issues.push({ row: rowNum, col: col, severity: 'warning', msg: msg, serial: serial || '', refName: refName || '' });
  }
  function checkCase(rowNum, colKey, trimmedVal, canonicalList, serial, refName) {
    if (!trimmedVal) return;
    const lower = trimmedVal.toLowerCase();
    const match = canonicalList.find(c => c.toLowerCase() === lower);
    if (match && match !== trimmedVal) {
      warn(rowNum, colKey, `'${trimmedVal}' works (matched case-insensitively) but doesn't match the standard casing '${match}' — fix for consistency.`, serial, refName);
    }
  }

  const seenPerModel = {};

  for (let r = 0; r < data.length; r++) {
    const rowNum = r + 2;
    if (data[r].every(v => v === '' || v === null || v === undefined)) continue;

    const serial = field(r, rowNum, 'serial');
    const refName = field(r, rowNum, 'paramName');
    const displayName = field(r, rowNum, 'displayName');
    const grouping = field(r, rowNum, 'grouping');
    const paramCategory = field(r, rowNum, 'paramCategory');
    const globalId = field(r, rowNum, 'globalId');
    const isGlobalRow = paramCategory.toLowerCase() === 'global' || !!globalId;

    if (!serial) err(rowNum, 'serial', 'Model serial ID is empty.', serial, refName);
    if (!refName) {
      err(rowNum, 'paramName', 'Parameter Name is required.', serial, refName);
    } else if (!/^[a-zA-Z0-9_]+$/.test(refName)) {
      err(rowNum, 'paramName', 'Parameter Name must be alphanumeric/underscore only.', serial, refName);
    } else if (serial) {
      if (!seenPerModel[serial]) seenPerModel[serial] = {};
      if (seenPerModel[serial][refName]) {
        err(rowNum, 'paramName', `Duplicate '${refName}' for this model — combine into one row instead.`, serial, refName);
      } else {
        seenPerModel[serial][refName] = true;
      }
    }
    if (!displayName) err(rowNum, 'displayName', 'Display Name is required.', serial, refName);
    if (!grouping) err(rowNum, 'grouping', 'Grouping is required.', serial, refName);

    checkCase(rowNum, 'paramCategory', paramCategory, ['Global', 'Local'], serial, refName);

    const imosOutputCondition = field(r, rowNum, 'imosOutputCondition');
    if (imosOutputCondition && !checkParens(imosOutputCondition)) {
      err(rowNum, 'imosOutputCondition', 'Unbalanced parentheses.', serial, refName);
    }

    if (isGlobalRow) continue;

    const pTypeRaw = field(r, rowNum, 'paramType');
    const pType = pTypeRaw.toLowerCase();
    const dTypeRaw = field(r, rowNum, 'dataType');
    const dType = dTypeRaw.toLowerCase();
    const value = field(r, rowNum, 'value');
    const min = field(r, rowNum, 'min');
    const max = field(r, rowNum, 'max');
    const compositeTypeRaw = field(r, rowNum, 'compositeType');
    const compositeType = compositeTypeRaw.toLowerCase();
    const valueRelationshipRaw = field(r, rowNum, 'valueRelationship');
    const valueRelationship = valueRelationshipRaw.toLowerCase();
    const defaultStateRaw = field(r, rowNum, 'defaultState');
    const defaultState = defaultStateRaw.toLowerCase();
    const materialRangeRaw = field(r, rowNum, 'materialRange');
    const materialRange = materialRangeRaw.toLowerCase();
    const expressionTypeRaw = field(r, rowNum, 'expressionType');
    const expressionType = expressionTypeRaw.toLowerCase();
    const optionsRaw = field(r, rowNum, 'options');
    const expressionRaw = field(r, rowNum, 'expression');
    const hideCondition = field(r, rowNum, 'hideCondition');

    if (!pType) {
      err(rowNum, 'paramType', 'Parameter type is required.', serial, refName);
    } else if (!TYPE_DATATYPE_MAP[pType]) {
      err(rowNum, 'paramType', `Unknown Parameter type '${pTypeRaw}'.`, serial, refName);
    } else {
      checkCase(rowNum, 'paramType', pTypeRaw, PARAM_TYPE_CANONICAL, serial, refName);
    }
    if (!dType) {
      err(rowNum, 'dataType', 'Data type is required.', serial, refName);
    } else if (TYPE_DATATYPE_MAP[pType] && TYPE_DATATYPE_MAP[pType].map(x => x.toLowerCase()).indexOf(dType) === -1) {
      err(rowNum, 'dataType', `'${dTypeRaw}' is not valid for Parameter type '${pTypeRaw}'.`, serial, refName);
    } else if (TYPE_DATATYPE_MAP[pType]) {
      checkCase(rowNum, 'dataType', dTypeRaw, TYPE_DATATYPE_MAP[pType], serial, refName);
    }

    const isAsset = ASSET_TYPES.indexOf(pType) !== -1;

    if (pType === 'boolean' && value) {
      const lv = value.toLowerCase();
      if (['true', 'false', '0', '1'].indexOf(lv) === -1) err(rowNum, 'value', 'Boolean value must be true/false/0/1.', serial, refName);
    }
    if (['float', 'integer'].indexOf(pType) !== -1 && dType === 'fixed value' && value && isNaN(Number(value))) {
      err(rowNum, 'value', `Numeric value expected, got '${value}'.`, serial, refName);
    }

    if (!isAsset && (dType === 'range' || dType === 'interval')) {
      if (!min) err(rowNum, 'min', 'Minimum is required for Range/Interval.', serial, refName);
      if (!max) err(rowNum, 'max', 'Maximum is required for Range/Interval.', serial, refName);
    }

    if (!isAsset && dType === 'advanced formula') {
      if (!compositeType) {
        err(rowNum, 'compositeType', 'Composite type is required for Advanced Formula.', serial, refName);
      } else if (['range', 'options'].indexOf(compositeType) === -1) {
        err(rowNum, 'compositeType', `Invalid Composite type '${compositeTypeRaw}'.`, serial, refName);
      } else {
        checkCase(rowNum, 'compositeType', compositeTypeRaw, ['Range', 'Options'], serial, refName);
      }
      if (!valueRelationship) {
        err(rowNum, 'valueRelationship', 'Value relationships is required for Advanced Formula.', serial, refName);
      } else if (['outside', 'within'].indexOf(valueRelationship) === -1) {
        err(rowNum, 'valueRelationship', `Invalid Value relationships '${valueRelationshipRaw}'.`, serial, refName);
      } else {
        checkCase(rowNum, 'valueRelationship', valueRelationshipRaw, ['Outside', 'Within'], serial, refName);
      }
      if (compositeType === 'range') {
        if (!min) err(rowNum, 'min', 'Minimum is required for Advanced Formula + Range.', serial, refName);
        if (!max) err(rowNum, 'max', 'Maximum is required for Advanced Formula + Range.', serial, refName);
      }
    }

    if (isAsset && (dType === 'options' || dType === 'advanced formula')) {
      if (!materialRange) {
        err(rowNum, 'materialRange', 'Range Type is required for Options / Advanced Formula on Material, Style, or Contour.', serial, refName);
      } else if (['select', 'condition'].indexOf(materialRange) === -1) {
        err(rowNum, 'materialRange', `Invalid Range Type '${materialRangeRaw}'.`, serial, refName);
      } else {
        checkCase(rowNum, 'materialRange', materialRangeRaw, ['Select', 'Condition'], serial, refName);
      }
    }
    if (isAsset && (dType === 'formula' || dType === 'advanced formula')) {
      if (!expressionType) {
        err(rowNum, 'expressionType', 'Expression Type is required for Formula / Advanced Formula on Material, Style, or Contour.', serial, refName);
      } else if (['reference', 'condition'].indexOf(expressionType) === -1) {
        err(rowNum, 'expressionType', `Invalid Expression Type '${expressionTypeRaw}'.`, serial, refName);
      } else {
        checkCase(rowNum, 'expressionType', expressionTypeRaw, ['Reference', 'Condition'], serial, refName);
      }
    }
    if (dType === 'advanced formula') {
      if (!defaultState) {
        err(rowNum, 'defaultState', 'Default state is required for Advanced Formula.', serial, refName);
      } else if (['value', 'formula'].indexOf(defaultState) === -1) {
        err(rowNum, 'defaultState', `Invalid Default state '${defaultStateRaw}'.`, serial, refName);
      } else {
        checkCase(rowNum, 'defaultState', defaultStateRaw, ['Value', 'Formula'], serial, refName);
      }
    }

    if (!isAsset && dType === 'advanced formula' && !expressionRaw) {
      err(rowNum, 'expression', 'Expression is required for Advanced Formula.', serial, refName);
    }
    if (dType === 'formula' && !expressionRaw) {
      err(rowNum, 'expression', 'Expression is required for Formula.', serial, refName);
    }
    if (isAsset && dType === 'advanced formula' && expressionType && !expressionRaw) {
      err(rowNum, 'expression', 'Expression is required for Advanced Formula.', serial, refName);
    }

    if (!isAsset) {
      if (dType === 'options' || (dType === 'advanced formula' && compositeType === 'options')) {
        if (!optionsRaw) {
          err(rowNum, 'options', 'Options is required for this Data type.', serial, refName);
        } else {
          try {
            const parsed = JSON.parse(optionsRaw);
            if (!Array.isArray(parsed)) throw new Error('not array');
            parsed.forEach((o, oi) => {
              if (!o || o.name === undefined || o.value === undefined) throw new Error('entry ' + oi + ' missing name/value');
            });
          } catch (e) {
            err(rowNum, 'options', `Options is not a valid JSON array of {name,value}: ${e.message}`, serial, refName);
          }
        }
      } else if ((dType === 'range' || dType === 'interval' || (dType === 'advanced formula' && compositeType === 'range')) && optionsRaw) {
        try {
          const parsed = JSON.parse(optionsRaw);
          if (!Array.isArray(parsed)) throw new Error('not array');
        } catch (e) {
          err(rowNum, 'options', `Recommends value is not a valid JSON array: ${e.message}`, serial, refName);
        }
      }
    } else {
      const usesLink = dType === 'options' || (dType === 'advanced formula' && materialRange);
      if (usesLink) {
        if (!optionsRaw) {
          err(rowNum, 'options', 'Options is required when Range Type is set.', serial, refName);
        } else if (materialRange === 'condition') {
          try {
            const parsed = JSON.parse(optionsRaw);
            if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) throw new Error('expected {"cases":[...],"defaultValue":...}');
          } catch (e) {
            err(rowNum, 'options', `Options must be a JSON {"cases":[...],"defaultValue":...} block for Range Type = Condition: ${e.message}`, serial, refName);
          }
        } else if (materialRange === 'select' && optionsRaw.trim().indexOf('{') === 0) {
          err(rowNum, 'options', 'Options should be a single plain asset id for Range Type = Select, not JSON.', serial, refName);
        }
      }
      if (expressionType === 'condition' && expressionRaw) {
        try {
          const parsed = JSON.parse(expressionRaw);
          if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) throw new Error('expected {"cases":[...],"defaultValue":...}');
        } catch (e) {
          err(rowNum, 'expression', `Expression must be a JSON {"cases":[...],"defaultValue":...} block for Expression Type = Condition: ${e.message}`, serial, refName);
        }
      }
    }

    if (!isAsset && expressionRaw && expressionRaw.trim().indexOf('{') === 0) {
      try { JSON.parse(expressionRaw); } catch (e) { err(rowNum, 'expression', 'Expression contains invalid JSON.', serial, refName); }
    }

    [['hideCondition', hideCondition], ['min', min], ['max', max], ['expression', !isAsset ? expressionRaw : (expressionType === 'reference' ? expressionRaw : '')]].forEach(([colKey, val]) => {
      if (val && !checkParens(val)) err(rowNum, colKey, 'Unbalanced parentheses.', serial, refName);
    });

    const lockedRaw = field(r, rowNum, 'lockedCondition');
    const lockedVal = lockedRaw.toLowerCase();
    if (lockedVal && ['true', 'false', 'locked'].indexOf(lockedVal) === -1) {
      err(rowNum, 'lockedCondition', `Invalid value '${lockedRaw}'.`, serial, refName);
    }
  }

  applyValidationHighlights(sheet, lastRow, lastCol, issues);
  writeValidationLog(ss, issues, headerRow);

  const errCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;
  ui.alert(
    errCount === 0
      ? `No blocking errors. ${warnCount} formatting warning(s) highlighted in yellow. Full details in the "Validation Log" tab.`
      : `${errCount} error(s) highlighted in red, ${warnCount} warning(s) in yellow. Fix red cells before running the batch update — full details in the "Validation Log" tab.`
  );
}

function applyValidationHighlights(sheet, lastRow, lastCol, issues) {
  const numRows = lastRow - 1;
  const backgrounds = [];
  const notes = [];
  for (let r = 0; r < numRows; r++) {
    backgrounds.push(new Array(lastCol).fill(null));
    notes.push(new Array(lastCol).fill(''));
  }

  const cellMap = {};
  issues.forEach(function (issue) {
    const r = issue.row - 2;
    const c = issue.col - 1;
    if (r < 0 || r >= numRows || c < 0 || c >= lastCol) return;
    const key = r + ',' + c;
    if (!cellMap[key]) cellMap[key] = { severity: issue.severity, notes: [] };
    if (issue.severity === 'error') cellMap[key].severity = 'error';
    cellMap[key].notes.push((issue.severity === 'error' ? 'ERROR: ' : 'WARNING: ') + issue.msg);
  });

  Object.keys(cellMap).forEach(function (key) {
    const parts = key.split(',');
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    const entry = cellMap[key];
    backgrounds[r][c] = entry.severity === 'error' ? COLOR_ERROR : COLOR_WARNING;
    notes[r][c] = entry.notes.join('\n');
  });

  sheet.getRange(2, 1, numRows, lastCol).setBackgrounds(backgrounds);
  sheet.getRange(2, 1, numRows, lastCol).setNotes(notes);
}

function clearValidationHighlights() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return;
  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  range.setBackground(null);
  range.clearNote();
}

function writeValidationLog(ss, issues, headerRow) {
  let logSheet = ss.getSheetByName('Validation Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Validation Log');
  } else {
    logSheet.clear();
  }
  const header = ['Severity', 'Row', 'Column', 'Model Serial', 'Parameter Name', 'Message'];
  logSheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  logSheet.setFrozenRows(1);

  if (issues.length === 0) {
    logSheet.getRange(2, 1).setValue('No issues found.');
    return;
  }

  const rows = issues
    .slice()
    .sort(function (a, b) { return a.row - b.row; })
    .map(function (issue) {
      const headerText = headerRow[issue.col - 1] || ('Column ' + issue.col);
      return [
        issue.severity === 'error' ? 'ERROR' : 'WARNING',
        issue.row,
        headerText,
        issue.serial || '',
        issue.refName || '',
        issue.msg
      ];
    });
  logSheet.getRange(2, 1, rows.length, header.length).setValues(rows);

  rows.forEach(function (row, i) {
    const rowNum = i + 2;
    logSheet.getRange(rowNum, 1, 1, header.length).setBackground(row[0] === 'ERROR' ? COLOR_ERROR : COLOR_WARNING);
  });

  logSheet.autoResizeColumns(1, header.length);
}
