/**
 * Parameter Add tools:
 *   (1) cascading Data type dropdown
 *   (2) LIVE red/yellow validation — every rule below is ported 1:1 from
 *       the Tampermonkey batch-update script's validateParamEditRows(), so
 *       "red" here means exactly "would block Run" there. Runs on every
 *       edit to the row you're editing (not just when you click a menu),
 *       so a required-but-empty field (e.g. Options is blank while Data
 *       type = Options) goes red immediately, not just after a manual
 *       validate pass.
 *   (3) "Validate Sheet" menu action — the same rule set run across the
 *       WHOLE sheet at once, plus the one thing live per-row editing
 *       structurally can't catch by itself: duplicate Parameter Name
 *       within the same model (needs to see every row, not just the one
 *       you're editing). Writes a "Validation Log" tab.
 *
 * This ONE file replaces any previous version — paste over the whole
 * script project (everything shares column-resolution helpers and there
 * can only be one onEdit/onOpen per project, so it must live together).
 *
 * ---------------------------------------------------------------------
 * WHY THERE'S NO SEPARATE "REQUIRED FIELD" COLOR ANYMORE
 * ---------------------------------------------------------------------
 * An earlier version of this script had a third, light-blue "this field
 * matters for your current selection and is still empty" hint, separate
 * from red errors. That turned out to be the wrong split: every field
 * that hint tracked as "required" already has a matching red rule below
 * (e.g. "Options is required for this Data type." IS an addErr() rule,
 * not just a hint) — so a required-and-empty field was quietly sitting in
 * a soft blue instead of the same red every other error gets, which is
 * exactly the "Float + Options with Options still blank" case that didn't
 * highlight. Rather than keep two colors saying overlapping things, this
 * version merges them: required-and-empty is red, live, same as any other
 * error. If you want a distinct color back, it can be added — say so.
 *
 * ---------------------------------------------------------------------
 * COLORS
 * ---------------------------------------------------------------------
 * RED   (#f4c7c3) — hard error: missing required field, invalid enum
 *         value, malformed JSON in Options/Expression, unbalanced
 *         parentheses, non-numeric where a number is expected, duplicate
 *         Parameter Name (Validate Sheet only — see above).
 * YELLOW (#fce8b2) — format/style warning, still technically accepted:
 *         leading/trailing whitespace, or an enum value that matches
 *         case-insensitively but not in the standard casing (e.g.
 *         'select' instead of 'Select').
 * Both match Sheets' own built-in "Format cells if" red/yellow presets so
 * they look native.
 *
 * ---------------------------------------------------------------------
 * USE
 * ---------------------------------------------------------------------
 * Install: Extensions > Apps Script > select all > paste this file >
 * Save. Reload the spreadsheet tab (custom menus only appear after a
 * fresh load, or Run > onOpen once from the Apps Script editor).
 *
 * A "Parameter Tools" menu appears with:
 *   - Validate Sheet (Highlight Errors)   — full-sheet check + duplicate
 *     detection + writes/refreshes the "Validation Log" tab
 *   - Clear Validation Highlights         — wipes backgrounds/notes
 *   - Refresh All Rows (Dropdown + Highlights) — backfills the cascading
 *     dropdown and live red/yellow on rows you filled in before
 *     installing (new edits get both live from here on, automatically)
 *
 * Both Validate Sheet and live editing reset backgrounds/notes on the
 * cells they manage before reapplying — don't use cell background color
 * in this sheet for anything else, it'll get overwritten.
 *
 * ---------------------------------------------------------------------
 * SHEET-ONLY ADVISORY RULE (beyond the ported set)
 * ---------------------------------------------------------------------
 * One yellow warning is NOT ported from the userscript: any local row with
 * no Value filled in. The userscript's own compiler (compileParamEditRow)
 * sets input.value from the CSV Value cell whenever it's non-empty —
 * `if (row.value !== '') input.value = row.value` — and that gate is
 * unconditional on Data type, so Value is meaningful for essentially every
 * Parameter type/Data type combination (Range, Options, Formula, Advanced
 * Formula, assets — not just Fixed Value/Unlimited). Leaving it blank still
 * runs fine (falls back to the skeleton's empty/0 default), so this is
 * deliberately a WARNING, not an error — flagged because it's usually a
 * mistake, not because the batch script will reject it.
 *
 * Also sheet-only, but RED (these describe genuinely broken data, not
 * style): for Float/Integer, Value/Minimum/Maximum and every Options
 * entry's "value" must be numeric (a "#"/"@" formula reference is exempt).
 * Integer specifically rejects decimals ("1.5" is invalid for Integer,
 * valid for Float — Float accepts both whole and decimal numbers). For
 * Float2, Value must be an "x,y" pair or {"x":...,"y":...} JSON, matching
 * Utils.formatFloat2's own parsing. Within an Options entry, Name and
 * Ignore may be left blank, but Value may not — an empty "value":"" is
 * flagged the same as the key being missing entirely, since every option
 * needs an actual value to select even when it doesn't need a name. And
 * every Options entry may only carry name/value/ignore — any other key
 * (e.g. "ignor" instead of "ignore") is flagged yellow as a likely typo,
 * since a misspelled key is silently dropped by the batch script rather
 * than doing what you meant. And for Range/Interval (and Advanced Formula
 * + Composite type = Range), Value must actually fall within Minimum and
 * Maximum — e.g. Minimum 0 / Maximum 100 / Value 101 now errors; before,
 * only Min/Max's presence was checked, never that Value was between them.
 * A Reference-type Expression (Material/Style/Contour, e.g. "#CZ") must
 * start with # or @, and — Validate Sheet only, since it needs the whole
 * sheet's Parameter Names, not just one row — is checked (yellow) against
 * every Parameter Name in the sheet plus the built-in #W/#D/#H, flagging
 * likely typos without asserting anything about the target's own type.
 * None of this is ported from the userscript
 * (which never checked Options entry value types, blankness, or key
 * names) — added because leaving these unchecked meant real data-format
 * mistakes went completely unflagged.
 *
 * ---------------------------------------------------------------------
 * PERFORMANCE
 * ---------------------------------------------------------------------
 * Column resolution (matching your headers to the fields above) is
 * cached per document for 5 minutes via CacheService, instead of
 * re-scanning the header row on every single keystroke — that scan was
 * the actual source of the lag, not the dropdown itself. The cache is
 * invalidated automatically whenever you edit row 1 (the headers).
 */

const DATA_SHEET_NAME = 'Parameter Add';
const COLOR_ERROR = '#f4c7c3';
const COLOR_WARNING = '#fce8b2';

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

// Every colKey validateRowCore() can flag — used to know which columns to
// reset/rewrite on each live pass and each full Validate Sheet pass.
const VALIDATED_KEYS = ['serial', 'paramName', 'displayName', 'grouping', 'paramCategory', 'imosOutputCondition',
  'paramType', 'dataType', 'value', 'min', 'max', 'compositeType', 'valueRelationship', 'materialRange',
  'expressionType', 'defaultState', 'expression', 'options', 'hideCondition', 'lockedCondition']; // 'value' included for the Fixed Value/Unlimited advisory above

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

const COL_CACHE_KEY = 'paramAddColMap_v1';

function resolveColumns(sheet) {
  const cache = CacheService.getDocumentCache();
  if (cache) {
    const cached = cache.get(COL_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* corrupt cache entry — fall through and recompute */ }
    }
  }

  const headerMap = getHeaderMap(sheet);
  const cols = {};
  for (const key in FIELDS) {
    cols[key] = findColumn(headerMap, FIELDS[key]);
  }

  if (cache) {
    try { cache.put(COL_CACHE_KEY, JSON.stringify(cols), 300); } catch (e) { /* cache write failed — harmless, just recomputes next time */ }
  }
  return cols;
}

function invalidateColumnCache() {
  const cache = CacheService.getDocumentCache();
  if (cache) cache.remove(COL_CACHE_KEY);
}

function checkParens(str) {
  const open = (str.match(/\(/g) || []).length;
  const close = (str.match(/\)/g) || []).length;
  return open === close;
}

// A "#Ref" or "@Ref" style formula reference is exempt from numeric checks
// below — those are legitimate non-literal values, matching how the
// userscript itself treats "#"-prefixed strings elsewhere (e.g. Quotation
// Width/Depth/Height).
function isFormulaRef(v) {
  return typeof v === 'string' && (v.indexOf('#') !== -1 || v.indexOf('@') !== -1);
}

const NUMERIC_PARAM_TYPES = ['float', 'integer'];

// Integer must be a whole number — a decimal like "1.5" is invalid for
// Integer even though it's perfectly valid for Float. Float accepts both
// whole and decimal numbers. Returns an error message string, or null if
// the value is fine for the given Parameter type.
function checkNumericForType(v, pType, pTypeRaw) {
  if (isFormulaRef(v)) return null;
  const n = Number(v);
  if (isNaN(n)) return `Numeric value expected, got '${v}' — Parameter type is ${pTypeRaw}.`;
  if (pType === 'integer' && !Number.isInteger(n)) {
    return `'${v}' has a decimal — Parameter type is Integer, which only accepts whole numbers (Float accepts both whole and decimal).`;
  }
  return null;
}

// Sheet-only check (see header comment): each Options entry should only
// carry name/value/ignore — anything else is almost always a typo (e.g.
// "ignor" instead of "ignore"), which the batch script would otherwise
// silently drop instead of doing what you intended.
// Sheet-only check (see header comment): Range/Interval means Value should
// actually fall within Minimum..Maximum — that was never checked before,
// only that Min/Max themselves were present. Skipped when Value or the
// bound is a formula reference, since a dynamically-computed number can't
// be checked at authoring time.
function checkValueInRange(value, min, max, err) {
  if (!value || isFormulaRef(value) || isFormulaRef(min) || isFormulaRef(max)) return;
  const v = Number(value);
  if (isNaN(v)) return; // already flagged by checkNumericForType
  if (min) {
    const lo = Number(min);
    if (!isNaN(lo) && v < lo) err('value', `Value '${value}' is below Minimum (${min}).`);
  }
  if (max) {
    const hi = Number(max);
    if (!isNaN(hi) && v > hi) err('value', `Value '${value}' is above Maximum (${max}).`);
  }
}

const OPTION_ENTRY_ALLOWED_KEYS = ['name', 'value', 'ignore'];

// Shared by both the non-asset Options branch and the Advanced Formula +
// Composite type = Options branch (same JSON shape). Reports every entry's
// problems rather than stopping at the first bad one, so a typo on entry 2
// doesn't hide a numeric mismatch on entry 5.
//
// Name and Ignore may be blank ("") — confirmed acceptable. Value may NOT
// be blank even though the "value" key is present: an empty string there
// is still a real, meaningful gap (unlike Name/Ignore, every option needs
// an actual value to select), so it's checked for emptiness specifically,
// not just for the key being absent.
function validateOptionEntries(parsed, pType, pTypeRaw, colKey, err, warn) {
  parsed.forEach((o, oi) => {
    if (!o || o.name === undefined || o.value === undefined) {
      err(colKey, `Options entry ${oi + 1} is missing "name" or "value".`);
      return;
    }
    if (String(o.value).trim() === '') {
      err(colKey, `Options entry ${oi + 1} is missing a Value — Name and Ignore can be left blank, but Value is required.`);
      return;
    }
    Object.keys(o).forEach(function (k) {
      if (OPTION_ENTRY_ALLOWED_KEYS.indexOf(k) === -1) {
        warn(colKey, `Options entry ${oi + 1} ("${o.name}") has an unrecognized key "${k}" — expected only name/value/ignore. This is usually a typo, and a misspelled key is silently dropped instead of doing what you intended.`);
      }
    });
    if (NUMERIC_PARAM_TYPES.indexOf(pType) !== -1) {
      const msg = checkNumericForType(String(o.value), pType, pTypeRaw);
      if (msg) err(colKey, `Options entry ${oi + 1} ("${o.name}"): ${msg}`);
    }
  });
}

// =========================================================================
// MENU
// =========================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Parameter Tools')
    .addItem('Validate Sheet (Highlight Errors)', 'validateParameterSheet')
    .addItem('Clear Validation Highlights', 'clearValidationHighlights')
    .addItem('Refresh All Rows (Dropdown + Highlights)', 'refreshAllRows')
    .addToUi();
}

// =========================================================================
// SHARED ROW VALIDATION CORE
// (ported 1:1 from the userscript's validateParamEditRows) — operates
// purely on colKey/value, no sheet access, so both the live per-row path
// and the full-sheet Validate Sheet path can share it.
// =========================================================================
function validateRowCore(field, issues, duplicateTracker, refResolver) {
  function err(colKey, msg) { issues.push({ colKey: colKey, severity: 'error', msg: msg }); }
  function warn(colKey, msg) { issues.push({ colKey: colKey, severity: 'warning', msg: msg }); }
  function checkCase(colKey, trimmedVal, canonicalList) {
    if (!trimmedVal) return;
    const lower = trimmedVal.toLowerCase();
    const match = canonicalList.find(c => c.toLowerCase() === lower);
    if (match && match !== trimmedVal) {
      warn(colKey, `'${trimmedVal}' works (matched case-insensitively) but doesn't match the standard casing '${match}' — fix for consistency.`);
    }
  }

  const serial = field('serial');
  const refName = field('paramName');
  const displayName = field('displayName');
  const grouping = field('grouping');
  const paramCategory = field('paramCategory');
  const globalId = field('globalId');
  const isGlobalRow = paramCategory.toLowerCase() === 'global' || !!globalId;

  if (!serial) err('serial', 'Model serial ID is empty.');
  if (!refName) {
    err('paramName', 'Parameter Name is required.');
  } else if (!/^[a-zA-Z0-9_]+$/.test(refName)) {
    err('paramName', 'Parameter Name must be alphanumeric/underscore only.');
  } else if (serial && duplicateTracker && duplicateTracker.isDuplicate(serial, refName)) {
    err('paramName', `Duplicate '${refName}' for this model — combine into one row instead.`);
  }
  if (!displayName) err('displayName', 'Display Name is required.');
  if (!grouping) err('grouping', 'Grouping is required.');

  checkCase('paramCategory', paramCategory, ['Global', 'Local']);

  const imosOutputCondition = field('imosOutputCondition');
  if (imosOutputCondition && !checkParens(imosOutputCondition)) {
    err('imosOutputCondition', 'Unbalanced parentheses.');
  }

  if (isGlobalRow) return { serial: serial, refName: refName };

  const pTypeRaw = field('paramType');
  const pType = pTypeRaw.toLowerCase();
  const dTypeRaw = field('dataType');
  const dType = dTypeRaw.toLowerCase();
  const value = field('value');
  const min = field('min');
  const max = field('max');
  const compositeTypeRaw = field('compositeType');
  const compositeType = compositeTypeRaw.toLowerCase();
  const valueRelationshipRaw = field('valueRelationship');
  const valueRelationship = valueRelationshipRaw.toLowerCase();
  const defaultStateRaw = field('defaultState');
  const defaultState = defaultStateRaw.toLowerCase();
  const materialRangeRaw = field('materialRange');
  const materialRange = materialRangeRaw.toLowerCase();
  const expressionTypeRaw = field('expressionType');
  const expressionType = expressionTypeRaw.toLowerCase();
  const optionsRaw = field('options');
  const expressionRaw = field('expression');
  const hideCondition = field('hideCondition');

  if (!pType) {
    err('paramType', 'Parameter type is required.');
  } else if (!TYPE_DATATYPE_MAP[pType]) {
    err('paramType', `Unknown Parameter type '${pTypeRaw}'.`);
  } else {
    checkCase('paramType', pTypeRaw, PARAM_TYPE_CANONICAL);
  }
  if (!dType) {
    err('dataType', 'Data type is required.');
  } else if (TYPE_DATATYPE_MAP[pType] && TYPE_DATATYPE_MAP[pType].map(x => x.toLowerCase()).indexOf(dType) === -1) {
    err('dataType', `'${dTypeRaw}' is not valid for Parameter type '${pTypeRaw}'.`);
  } else if (TYPE_DATATYPE_MAP[pType]) {
    checkCase('dataType', dTypeRaw, TYPE_DATATYPE_MAP[pType]);
  }

  const isAsset = ASSET_TYPES.indexOf(pType) !== -1;

  if (pType === 'boolean' && value) {
    const lv = value.toLowerCase();
    if (['true', 'false', '0', '1'].indexOf(lv) === -1) err('value', 'Boolean value must be true/false/0/1.');
  }
  // Sheet-only checks (see header comment): the userscript only checked
  // numeric-ness of Value for Float/Integer + Fixed Value specifically —
  // broadened here to any Data type, since Value feeds input.value
  // regardless of Data type (same reasoning as the advisory below). Also
  // now Integer-aware: Integer rejects decimals, Float accepts either.
  if (NUMERIC_PARAM_TYPES.indexOf(pType) !== -1 && value) {
    const msg = checkNumericForType(value, pType, pTypeRaw);
    if (msg) err('value', msg);
  }
  if (pType === 'float2' && value && !isFormulaRef(value)) {
    const v = value.trim();
    let validFloat2 = false;
    if (v.startsWith('{') && v.endsWith('}')) {
      try {
        const obj = JSON.parse(v);
        validFloat2 = !!obj && typeof obj === 'object' && !isNaN(Number(obj.x)) && !isNaN(Number(obj.y));
      } catch (e) { validFloat2 = false; }
    } else {
      const parts = v.split(',');
      validFloat2 = parts.length === 2 && !isNaN(Number(parts[0].trim())) && !isNaN(Number(parts[1].trim()));
    }
    if (!validFloat2) {
      err('value', `Float2 value should be an "x,y" numeric pair (e.g. "0,0") or {"x":...,"y":...} JSON — got '${value}'.`);
    }
  }
  if (NUMERIC_PARAM_TYPES.indexOf(pType) !== -1) {
    [['min', min], ['max', max]].forEach(([colKey, v]) => {
      if (v) {
        const msg = checkNumericForType(v, pType, pTypeRaw);
        if (msg) err(colKey, msg);
      }
    });
  }
  // Sheet-only advisory (not ported from the userscript, see header comment):
  // compileParamEditRow's actual gate is `if (row.value !== '') input.value = row.value`
  // — unconditional on Data type, so a default Value is meaningful for every
  // combination (Range/Options/Formula/Advanced Formula/assets included, not
  // just Fixed Value/Unlimited). Leaving it blank still runs fine (falls back
  // to a blank/0 skeleton default), so this stays a warning, not an error.
  if (!value) {
    warn('value', `No Value (default value) set for this row — the batch script will still run (it falls back to an empty/zero default), but nearly every Parameter type/Data type combination accepts and uses one, so this is usually meant to have one.`);
  }

  if (!isAsset && (dType === 'range' || dType === 'interval')) {
    if (!min) err('min', 'Minimum is required for Range/Interval.');
    if (!max) err('max', 'Maximum is required for Range/Interval.');
    checkValueInRange(value, min, max, err);
  }

  if (!isAsset && dType === 'advanced formula') {
    if (!compositeType) {
      err('compositeType', 'Composite type is required for Advanced Formula.');
    } else if (['range', 'options'].indexOf(compositeType) === -1) {
      err('compositeType', `Invalid Composite type '${compositeTypeRaw}'.`);
    } else {
      checkCase('compositeType', compositeTypeRaw, ['Range', 'Options']);
    }
    if (!valueRelationship) {
      err('valueRelationship', 'Value relationships is required for Advanced Formula.');
    } else if (['outside', 'within'].indexOf(valueRelationship) === -1) {
      err('valueRelationship', `Invalid Value relationships '${valueRelationshipRaw}'.`);
    } else {
      checkCase('valueRelationship', valueRelationshipRaw, ['Outside', 'Within']);
    }
    if (compositeType === 'range') {
      if (!min) err('min', 'Minimum is required for Advanced Formula + Range.');
      if (!max) err('max', 'Maximum is required for Advanced Formula + Range.');
      checkValueInRange(value, min, max, err);
    }
  }

  if (isAsset && (dType === 'options' || dType === 'advanced formula')) {
    if (!materialRange) {
      err('materialRange', 'Range Type is required for Options / Advanced Formula on Material, Style, or Contour.');
    } else if (['select', 'condition'].indexOf(materialRange) === -1) {
      err('materialRange', `Invalid Range Type '${materialRangeRaw}'.`);
    } else {
      checkCase('materialRange', materialRangeRaw, ['Select', 'Condition']);
    }
  }
  if (isAsset && (dType === 'formula' || dType === 'advanced formula')) {
    if (!expressionType) {
      err('expressionType', 'Expression Type is required for Formula / Advanced Formula on Material, Style, or Contour.');
    } else if (['reference', 'condition'].indexOf(expressionType) === -1) {
      err('expressionType', `Invalid Expression Type '${expressionTypeRaw}'.`);
    } else {
      checkCase('expressionType', expressionTypeRaw, ['Reference', 'Condition']);
    }
  }
  if (dType === 'advanced formula') {
    if (!defaultState) {
      err('defaultState', 'Default state is required for Advanced Formula.');
    } else if (['value', 'formula'].indexOf(defaultState) === -1) {
      err('defaultState', `Invalid Default state '${defaultStateRaw}'.`);
    } else {
      checkCase('defaultState', defaultStateRaw, ['Value', 'Formula']);
    }
  }

  if (!isAsset && dType === 'advanced formula' && !expressionRaw) {
    err('expression', 'Expression is required for Advanced Formula.');
  }
  if (dType === 'formula' && !expressionRaw) {
    err('expression', 'Expression is required for Formula.');
  }
  if (isAsset && dType === 'advanced formula' && expressionType && !expressionRaw) {
    err('expression', 'Expression is required for Advanced Formula.');
  }

  if (!isAsset) {
    if (dType === 'options' || (dType === 'advanced formula' && compositeType === 'options')) {
      if (!optionsRaw) {
        err('options', 'Options is required for this Data type.');
      } else {
        let parsed = null;
        try {
          parsed = JSON.parse(optionsRaw);
          if (!Array.isArray(parsed)) throw new Error('not array');
        } catch (e) {
          err('options', `Options is not a valid JSON array of {name,value}: ${e.message}`);
          parsed = null;
        }
        if (parsed) validateOptionEntries(parsed, pType, pTypeRaw, 'options', err, warn);
      }
    } else if ((dType === 'range' || dType === 'interval' || (dType === 'advanced formula' && compositeType === 'range')) && optionsRaw) {
      try {
        const parsed = JSON.parse(optionsRaw);
        if (!Array.isArray(parsed)) throw new Error('not array');
      } catch (e) {
        err('options', `Recommends value is not a valid JSON array: ${e.message}`);
      }
    }
  } else {
    const usesLink = dType === 'options' || (dType === 'advanced formula' && materialRange);
    if (usesLink) {
      if (!optionsRaw) {
        err('options', 'Options is required when Range Type is set.');
      } else if (materialRange === 'condition') {
        try {
          const parsed = JSON.parse(optionsRaw);
          if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) throw new Error('expected {"cases":[...],"defaultValue":...}');
        } catch (e) {
          err('options', `Options must be a JSON {"cases":[...],"defaultValue":...} block for Range Type = Condition: ${e.message}`);
        }
      } else if (materialRange === 'select' && optionsRaw.trim().indexOf('{') === 0) {
        err('options', 'Options should be a single plain asset id for Range Type = Select, not JSON.');
      }
    }
    if (expressionType === 'condition' && expressionRaw) {
      try {
        const parsed = JSON.parse(expressionRaw);
        if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) throw new Error('expected {"cases":[...],"defaultValue":...}');
      } catch (e) {
        err('expression', `Expression must be a JSON {"cases":[...],"defaultValue":...} block for Expression Type = Condition: ${e.message}`);
      }
    }
    // Sheet-only check (see header comment): a "Reference" expression is a
    // pointer to another parameter (e.g. "#CZ", "#Style_Unlimited") — every
    // real example uses a leading # (or @). Flags plain text typed in by
    // mistake instead of an actual reference.
    if (expressionType === 'reference' && expressionRaw) {
      const refTrimmed = expressionRaw.trim();
      if (!/^[#@]/.test(refTrimmed)) {
        err('expression', `Reference expression should start with '#' or '@' (e.g. '#CZ') — got '${expressionRaw}'.`);
      } else if (refResolver && !refResolver.exists(refTrimmed.slice(1))) {
        warn('expression', `Reference '${refTrimmed}' doesn't match any Parameter Name in this sheet, or a known built-in (#W, #D, #H) — check for a typo, or confirm it's a valid system reference. (Only checked when you run Validate Sheet — live editing can't see the whole sheet's Parameter Names.)`);
      }
    }
  }

  if (!isAsset && expressionRaw && expressionRaw.trim().indexOf('{') === 0) {
    try { JSON.parse(expressionRaw); } catch (e) { err('expression', 'Expression contains invalid JSON.'); }
  }

  [['hideCondition', hideCondition], ['min', min], ['max', max], ['expression', !isAsset ? expressionRaw : (expressionType === 'reference' ? expressionRaw : '')]].forEach(([colKey, v]) => {
    if (v && !checkParens(v)) err(colKey, 'Unbalanced parentheses.');
  });

  const lockedRaw = field('lockedCondition');
  const lockedVal = lockedRaw.toLowerCase();
  if (lockedVal && ['true', 'false', 'locked'].indexOf(lockedVal) === -1) {
    err('lockedCondition', `Invalid value '${lockedRaw}'.`);
  }

  return { serial: serial, refName: refName };
}

// =========================================================================
// UNIFIED PER-ROW PASS: cascading Data type dropdown + live red/yellow
// validation, in ONE batched read/write cycle (this is what used to be
// two separate functions each doing their own getRange calls — merged to
// cut the per-edit round-trip count roughly in half, since that overhead,
// not the dropdown itself, was the actual source of the lag).
// =========================================================================
function processRow(sheet, row, cols, lastCol) {
  lastCol = lastCol || sheet.getLastColumn();
  const rowRange = sheet.getRange(row, 1, 1, lastCol);
  const values = rowRange.getValues()[0];
  const backgrounds = rowRange.getBackgrounds()[0];
  const notes = rowRange.getNotes()[0];
  let valuesChanged = false;

  function cellStr(colKey) {
    const col = cols[colKey];
    if (!col) return '';
    const v = values[col - 1];
    return (v === null || v === undefined) ? '' : String(v);
  }

  // --- Cascading Data type dropdown — touches ONLY the Data type cell's
  // own validation, via a scoped single-cell call, and NEVER reads/writes
  // the whole row's data validations as a batch.
  //
  // A previous version read the whole row's validations into one array
  // and wrote them all back together for speed. That was the actual bug
  // behind "Chip style keeps changing to Arrow": Apps Script's
  // DataValidation object has no property for Chip vs Arrow display (it's
  // not part of the exposed API at all, confirmed against Google's own
  // issue tracker) — so round-tripping ANY validation, including your
  // manually-built Chip dropdowns on Parameter Category/Grouping/
  // Parameter type, through getDataValidations()/setDataValidations()
  // silently drops that attribute and it renders as Arrow again. This
  // script never changes those columns' actual rules, but merely
  // reading-and-rewriting them alongside Data type's own validation was
  // enough to strip their styling on every single edit anywhere in the
  // row. Scoping to sheet.getRange(row, cols.dataType) below means Data
  // type is the only cell ever put through that round-trip — permanent
  // fix, not a workaround.
  if (cols.dataType && cols.paramType) {
    const paramType = cellStr('paramType').trim();
    const dtIdx = cols.dataType - 1;
    const dtCell = sheet.getRange(row, cols.dataType);
    if (!paramType) {
      dtCell.clearDataValidations();
      notes[dtIdx] = '';
      // Clearing Parameter type used to leave a stale Data type VALUE
      // behind (only the dropdown rule/note got cleared) — that stale
      // value then kept tripping downstream "Minimum is required for
      // Range" style errors even though Parameter type was blank again.
      if (cellStr('dataType').trim() !== '') { values[dtIdx] = ''; valuesChanged = true; }
    } else {
      const validTypes = TYPE_DATATYPE_MAP[paramType.toLowerCase()];
      if (!validTypes) {
        dtCell.clearDataValidations();
        notes[dtIdx] = 'Unknown Parameter type "' + paramType + '" — not in TYPE_DATATYPE_MAP in the Apps Script.';
      } else {
        dtCell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(validTypes, true).setAllowInvalid(false).build());
        const current = cellStr('dataType').trim();
        if (current && validTypes.indexOf(current) === -1) { values[dtIdx] = ''; valuesChanged = true; }
      }
    }
  }

  // --- Live red/yellow validation (reads the SAME in-memory values, so it
  // sees the just-cleared Data type immediately rather than a stale read) ---
  const rowIssues = [];
  function field(colKey) {
    const col = cols[colKey];
    if (!col) return '';
    const str = cellStr(colKey);
    const trimmed = str.trim();
    if (str !== trimmed && trimmed !== '') {
      rowIssues.push({ colKey: colKey, severity: 'warning', msg: 'Leading/trailing whitespace — values are trimmed automatically so this still works, but tidy it up if you can.' });
    }
    return trimmed;
  }
  // Skip a fully blank row entirely — otherwise deleting a row's content
  // re-triggers "Product serial number is empty" / "Parameter Name is
  // required" etc. on the very next edit, since blank required fields are
  // errors. That made Clear Validation Highlights look broken: it wiped
  // the color, then any subsequent edit anywhere immediately re-flagged
  // the still-listening blank row. validateParameterSheet already skips
  // blank rows the same way; this brings the live path in line with it.
  const rowIsBlank = values.every(function (v) { return v === '' || v === null || v === undefined; });
  // No duplicateTracker or refResolver here — both need the whole sheet's
  // Parameter Names, not just this row. Validate Sheet is the authority
  // for those two checks.
  if (!rowIsBlank) validateRowCore(field, rowIssues, null, null);

  VALIDATED_KEYS.forEach(function (key) {
    const col = cols[key];
    if (!col) return;
    backgrounds[col - 1] = '#ffffff';
    if (key !== 'dataType') notes[col - 1] = ''; // dataType's note is owned by the dropdown block above
  });

  const cellSeverity = {};
  rowIssues.forEach(function (issue) {
    const col = cols[issue.colKey];
    if (!col) return;
    const i = col - 1;
    if (issue.severity === 'error') cellSeverity[i] = 'error';
    else if (cellSeverity[i] !== 'error') cellSeverity[i] = 'warning';
    const tag = issue.severity === 'error' ? 'ERROR: ' : 'WARNING: ';
    notes[i] = notes[i] ? notes[i] + '\n' + tag + issue.msg : tag + issue.msg;
  });
  Object.keys(cellSeverity).forEach(function (i) {
    backgrounds[i] = cellSeverity[i] === 'error' ? COLOR_ERROR : COLOR_WARNING;
  });

  rowRange.setBackgrounds([backgrounds]);
  rowRange.setNotes([notes]);
  if (valuesChanged) rowRange.setValues([values]);
}

/** Run once to backfill the dropdown and live validation on rows that already have data. */
function refreshAllRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + DATA_SHEET_NAME + '" not found.');
  invalidateColumnCache();
  const cols = resolveColumns(sheet);
  if (!cols.paramType || !cols.dataType) {
    throw new Error('Could not find "Parameter type" and/or "Data type" columns by header text.');
  }
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return;
  for (let row = 2; row <= lastRow; row++) {
    processRow(sheet, row, cols, lastCol);
  }
}

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== DATA_SHEET_NAME) return;

  if (e.range.getRow() === 1) {
    invalidateColumnCache(); // headers changed — re-resolve (and re-cache) on the next data edit
    return;
  }

  const startRow = Math.max(e.range.getRow(), 2);
  const endRow = e.range.getRow() + e.range.getNumRows() - 1;
  if (startRow > endRow) return;

  const cols = resolveColumns(sheet);
  if (!cols.paramType || !cols.dataType) return;

  const lastCol = sheet.getLastColumn();
  for (let row = startRow; row <= endRow; row++) {
    processRow(sheet, row, cols, lastCol);
  }
}

// =========================================================================
// FULL-SHEET VALIDATE (menu action) — same rules, plus duplicate-name
// detection across the whole sheet, plus the Validation Log tab.
// =========================================================================
function validateParameterSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_SHEET_NAME);
  const ui = SpreadsheetApp.getUi();
  if (!sheet) { ui.alert('Sheet "' + DATA_SHEET_NAME + '" not found.'); return; }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) { ui.alert('No data rows to validate.'); return; }

  invalidateColumnCache();
  const cols = resolveColumns(sheet);

  const requiredCols = { serial: 'Product serial number', paramName: 'Parameter Name', displayName: 'Display Name', grouping: 'Grouping' };
  const missing = Object.keys(requiredCols).filter(k => !cols[k]);
  if (missing.length > 0) {
    ui.alert('Missing required column(s): ' + missing.map(k => requiredCols[k]).join(', ') + '. Add them before validating.');
    return;
  }

  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const allIssues = []; // {row, col, severity, msg, serial, refName}

  const duplicateTracker = {
    seen: {},
    isDuplicate: function (serial, refName) {
      if (!this.seen[serial]) this.seen[serial] = {};
      if (this.seen[serial][refName]) return true;
      this.seen[serial][refName] = true;
      return false;
    }
  };

  // Every Parameter Name in the sheet, lowercased, plus known built-in
  // system references (#W/#D/#H — the Quotation-level dimension refs) —
  // used to sanity-check "#XYZ" Reference expressions.
  const knownNames = {};
  ['w', 'd', 'h'].forEach(function (n) { knownNames[n] = true; });
  if (cols.paramName) {
    data.forEach(function (rowVals) {
      const raw = rowVals[cols.paramName - 1];
      const name = (raw === null || raw === undefined) ? '' : String(raw).trim();
      if (name) knownNames[name.toLowerCase()] = true;
    });
  }
  const refResolver = { exists: function (name) { return !!knownNames[String(name).trim().toLowerCase()]; } };

  for (let r = 0; r < data.length; r++) {
    const rowNum = r + 2;
    if (data[r].every(v => v === '' || v === null || v === undefined)) continue;

    const rowIssues = [];
    function field(colKey) {
      const col = cols[colKey];
      if (!col) return '';
      const raw = data[r][col - 1];
      const str = (raw === null || raw === undefined) ? '' : String(raw);
      const trimmed = str.trim();
      if (str !== trimmed && trimmed !== '') {
        rowIssues.push({ colKey: colKey, severity: 'warning', msg: 'Leading/trailing whitespace — values are trimmed automatically so this still works, but tidy it up if you can.' });
      }
      return trimmed;
    }

    const ctx = validateRowCore(field, rowIssues, duplicateTracker, refResolver);
    rowIssues.forEach(function (issue) {
      const col = cols[issue.colKey];
      if (!col) return;
      allIssues.push({ row: rowNum, col: col, severity: issue.severity, msg: issue.msg, serial: ctx.serial, refName: ctx.refName });
    });
  }

  applyValidationHighlights(sheet, lastRow, lastCol, allIssues);
  writeValidationLog(ss, allIssues, headerRow);

  const errCount = allIssues.filter(i => i.severity === 'error').length;
  const warnCount = allIssues.filter(i => i.severity === 'warning').length;
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
