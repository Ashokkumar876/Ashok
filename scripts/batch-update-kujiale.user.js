// ==UserScript==
// @name         Batch Update Pro (Kujiale Parametric Models)
// @version      1.0.0
// @description  Frozen UI batch editor for Kujiale/Coohom parametric models. Full CSV pre-validation, server-side pre-save validation, multi-parameter-per-model CSV support, dependency-safe deletes.
// @match        https://beta.kujiale.com/vc/modeleditor/new*
// @match        https://www.kujiale.com/vc/modeleditor/new*
// @match        https://www.homworksstudio.com/pub/tool/cpm/modeleditor/new*
// @match        https://prod-test-sg.coohom.com/pub/tool/cpm/modeleditor/new*
// @require      https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    /* global _ */

    // =========================================================================
    // SECTION 0: CONFIG
    // =========================================================================
    const CONFIG = {
        // Product-category id used by the pre-save validation endpoint. Carried
        // over from the legacy script — confirm this matches your Kujiale
        // catalog before trusting the pass/fail result of that check.
        PRODCATID: 695,
        REVIEW_SKIP_TEST: true
    };

    const THEME = {
        primary: '#0071e3', danger: '#ff453a', success: '#34c759',
        indigo: '#5e5ce6', warning: '#ff9f0a', bg: 'rgba(255, 255, 255, 0.98)',
        border: 'rgba(0, 0, 0, 0.06)', textMain: '#1d1d1f'
    };

    const TASK_REGISTRY = {
        QUOTE: { id: 'QUOTE', label: 'Quotation Output', color: THEME.indigo, icon: '⚡', implemented: true },
        PARAM_EDIT: { id: 'PARAM_EDIT', label: 'Add / Edit Params', color: THEME.primary, icon: '＋', implemented: true },
        PARAM_DEL: { id: 'PARAM_DEL', label: 'Delete Params', color: THEME.danger, icon: '－', implemented: true },
        // Edit matches an existing part by Reference name (row.partRefName)
        // — a row whose refName isn't already on a part in the model adds a
        // new one, matching refName edits that one in place. A blank
        // Reference name falls back to matching by Part Name instead (only
        // when it identifies exactly one existing part — see
        // compilePartEditRow); still adds if neither matches anything.
        PART_EDIT: { id: 'PART_EDIT', label: 'Add / Edit Parts', color: THEME.success, icon: '🧩', implemented: true },
        // Matches the part to delete by Reference name (row.partRefName) —
        // same identifier PART_EDIT uses to match an existing part.
        PART_DEL: { id: 'PART_DEL', label: 'Delete Parts', color: THEME.warning, icon: '🗑', implemented: true },
        // Edit-only — matched by exact Name (e.g. "Door Opening-1") against
        // editorData.customDoorHoles. Unlike Parts, a Door Opening isn't a
        // catalog item fetched from a library — it's a virtual hole the
        // cabinet/wardrobe frame generates on its own, so there's no "Add"
        // path here, only editing one that's already on the model.
        DOOR_OPENING_EDIT: { id: 'DOOR_OPENING_EDIT', label: 'Edit Door Openings', color: THEME.indigo, icon: '🚪', implemented: true }
    };

    let currentTask = null;
    let parsedData = null; // Map<serial, row[]> (row = single object for QUOTE)
    let preValidationErrors = [];
    let lastRunErrors = [];
    let lastDeleteSkippedProtected = []; // refNames of W/D/H/CZ silently skipped on PARAM_DEL
    let deleteResetValues = new Map(); // serial -> Map<refName, value> — optional reset for a skipped protected param, from the Delete CSV's own Value column
    let deleteProtectedNamesPerModel = new Map(); // serial -> Set<refName> — every protected/system param name skipped on PARAM_DEL for that model, whether or not the CSV gave it an explicit Value
    let categoryDefaultsCache = new Map(); // prodCatId -> Promise<Map<paramName, value>> — live template defaults, fetched once per category and reused

    // =========================================================================
    // SECTION 1: TOAST NOTIFICATIONS
    // =========================================================================
    function showNotification(message, color) {
        const toast = document.createElement('div');
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            padding: '12px 24px', backgroundColor: color, color: '#fff',
            borderRadius: '50px', boxShadow: '0 8px 20px rgba(0,0,0,0.2)',
            zIndex: '1000000', fontSize: '13px', fontWeight: 'bold', transition: 'all 0.3s ease'
        });
        toast.innerText = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.top = '10px';
            setTimeout(() => { toast.remove(); }, 300);
        }, 4000);
    }

    // =========================================================================
    // SECTION 2: LOW-LEVEL UTILITIES
    // =========================================================================
    const Utils = {
        // Kujiale's own condition editor stores and displays AND/OR
        // literally (confirmed: a Hide condition typed as "#D < 250 OR
        // #W < 350" came back showing "||" once this used to convert it —
        // the user wants the exact text they typed preserved). No operator
        // substitution — pass the expression through as-is, just trimmed.
        normalizeExpr: (str) => {
            if (!str || typeof str !== "string") return str;
            const trimmed = str.trim();
            // A bare boolean literal (the WHOLE field, e.g. a Hide condition
            // that's simply "always true") — confirmed real editorData
            // always stores this as lowercase "true"/"false" verbatim.
            // Spreadsheet software (Excel/Sheets) can silently
            // auto-capitalize a lone "true" to "TRUE" on edit/paste, and a
            // live run with that produced a raw server crash instead of a
            // normal rejection. Only an EXACT whole-field match is touched
            // here — "true"/"false" used inside a larger expression (e.g. a
            // ternary's branches, confirmed to use uppercase TRUE/FALSE in
            // real data — a different, correct convention) is left as-is.
            if (/^true$/i.test(trimmed)) return 'true';
            if (/^false$/i.test(trimmed)) return 'false';
            return trimmed;
        },
        // Handles both a JSON {"cases":[...]} formula-settings blob and a plain
        // JS-ish expression string ("#W < 50 ? 50 : 10") — both are valid
        // `formula` payloads observed in real editorData.
        normalizeExpression: (expr) => {
            if (!expr || typeof expr !== "string") return expr;
            const trimmed = expr.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed && Array.isArray(parsed.cases)) {
                        parsed.cases.forEach(c => { if (c.condition) c.condition = Utils.normalizeExpr(c.condition); });
                    }
                    return JSON.stringify(parsed);
                } catch (e) {
                    return Utils.normalizeExpr(trimmed);
                }
            }
            return Utils.normalizeExpr(trimmed);
        },
        // `link` (the Options/"Range Type" data) is ALWAYS a plain bare
        // asset id string for every asset type — Material and Style alike —
        // confirmed on Material_Options_Select/Condition and
        // Style_Options_Select/Condition alike. Never wrapped.
        wrapAssetLink: (val) => (val === null || val === undefined) ? val : String(val).trim(),
        // `value` (and literal case-values inside a Condition `formula`) differ
        // by Parameter type: Material stores a bare id string; Style stores a
        // JSON-stringified {obsBrandGoodId,versionId} object — confirmed on
        // Style_Unlimited vs Material_Unlimited. A "#Ref" reference is never
        // wrapped either way. Contour has no confirmed sample yet — treated
        // like Material (bare string) until verified otherwise.
        wrapAssetValue: (val, pType) => {
            if (val === null || val === undefined || val === "") return val;
            const v = String(val).trim();
            if (v.startsWith("#") || v.startsWith("@")) return v;
            if (v.startsWith("{")) return v; // already JSON, pass through
            if (pType === 'style' && /^[a-zA-Z0-9]{12,24}$/.test(v)) {
                return JSON.stringify({ obsBrandGoodId: v, versionId: 0 });
            }
            return v;
        },
        // float2 values are stored as a {"x":...,"y":...} JSON string (see
        // CZPY/CZCC in the reference editorData) — accepts either an "x,y"
        // pair or an already-JSON value from the CSV.
        formatFloat2: (val) => {
            if (val === null || val === undefined || val === "") return val;
            const trimmed = String(val).trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                try { JSON.parse(trimmed); return trimmed; } catch (e) { /* fall through to pair parsing */ }
            }
            const parts = trimmed.split(",");
            const x = (parts[0] && parts[0].trim()) ? parts[0].trim() : "0";
            const y = (parts[1] && parts[1].trim()) ? parts[1].trim() : "0";
            return JSON.stringify({ x, y });
        },
        // RFC 4180 CSV parser (handles quoted fields with embedded commas/newlines).
        parseCSV: (text) => {
            let c = '', rows = [], q = false, row = [''];
            for (let i = 0; i < text.length; i++) {
                c = text[i];
                const next = text[i + 1];
                if (c === '"') {
                    if (q && next === '"') { row[row.length - 1] += '"'; i++; }
                    else { q = !q; }
                } else if (c === ',') {
                    if (q) row[row.length - 1] += c; else row.push('');
                } else if (c === '\r' || c === '\n') {
                    if (q) { row[row.length - 1] += c; }
                    else {
                        if (c === '\r' && next === '\n') i++;
                        rows.push(row);
                        row = [''];
                    }
                } else {
                    row[row.length - 1] += c;
                }
            }
            if (row.length > 1 || row[0] !== '') rows.push(row);
            return rows;
        },
        normHeader: (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    };

    function findCol(normHeaders, ...patterns) {
        for (const p of patterns) {
            const idx = normHeaders.findIndex(h => h === p);
            if (idx !== -1) return idx;
        }
        // Short patterns (the "w"/"d"/"h" single-letter fallbacks for
        // Quotation's Width/Depth/Height) are exact-match only — as a
        // substring they can match unrelated columns purely by accident,
        // e.g. "d" inside "Product Name" once that column existed.
        for (const p of patterns) {
            if (p.length < 3) continue;
            const idx = normHeaders.findIndex(h => h.includes(p));
            if (idx !== -1) return idx;
        }
        return -1;
    }

    // Column set and names verified against real editorData.inputs entries —
    // see PARAM_TYPE_ID / grouping / asset-wrapping comments below for what
    // each one was confirmed against.
    function getColumnIndices(headers) {
        const n = headers.map(Utils.normHeader);
        return {
            serial: findCol(n, 'productserialnumber', 'modelid', 'serial'),
            paramCategory: findCol(n, 'parametercategory'),
            globalId: findCol(n, 'globalparameterid', 'globalid'),
            grouping: findCol(n, 'grouping', 'group'),
            paramType: findCol(n, 'parametertype'),
            dataType: findCol(n, 'datatype'),
            displayName: findCol(n, 'displayname'),
            paramName: findCol(n, 'parametername'),
            value: findCol(n, 'value'),
            min: findCol(n, 'minimum', 'min'),
            max: findCol(n, 'maximum', 'max'),
            step: findCol(n, 'stepsize', 'step'),
            options: findCol(n, 'options', 'recommends'),
            expression: findCol(n, 'expression', 'formulaexpression'),
            hideCondition: findCol(n, 'hidecondition'),
            lockedCondition: findCol(n, 'lockedcondition', 'lock'),
            defaultState: findCol(n, 'defaultstate'),
            imosOutputCondition: findCol(n, 'imosoutputcondition'),
            compositeType: findCol(n, 'compositetype', 'composite'),
            valueRelationship: findCol(n, 'valuerelationships', 'valuerelationship'),
            materialRange: findCol(n, 'rangetype', 'materialrange', 'range'),
            expressionType: findCol(n, 'expressiontype'),
            w: findCol(n, 'modelwidth', 'width', 'w'),
            d: findCol(n, 'modeldepth', 'depth', 'd'),
            h: findCol(n, 'modelheight', 'height', 'h'),
            // Parts (PART_EDIT) columns. childName is reference-only, not
            // read for anything functional.
            childSerial: findCol(n, 'childserialnumber', 'childserial'),
            partName: findCol(n, 'partname'),
            partRefName: findCol(n, 'referencename'),
            // Part attribute columns — every one of these maps to a "value"
            // field inside the newly-added instance's own parameters[]
            // (confirmed against a real editorData sample: Shutter
            // 1/2/3 show exactly this shape for each of these paramNames).
            styleParameter: findCol(n, 'styleparameter'),
            positionX: findCol(n, 'positionx'),
            positionY: findCol(n, 'positiony'),
            positionZ: findCol(n, 'positionz'),
            rotateX: findCol(n, 'rotatex'),
            rotateY: findCol(n, 'rotatey'),
            rotateZ: findCol(n, 'rotatez'),
            positionMethod: findCol(n, 'positionmethod'),
            // Distinct from 'hideCondition' above (PARAM_EDIT's "Hide
            // condition", singular) — this is Parts' "Hide Conditions"
            // (plural), a different column on a different CSV shape.
            partHideCondition: findCol(n, 'hideconditions'),
            partReplaceable: findCol(n, 'replaceable'),
            partQuotationRequired: findCol(n, 'quotationrequired'),
            partRemovable: findCol(n, 'removable'),
            partComponentRemovable: findCol(n, 'componentremovable'),
            partStylePack: findCol(n, 'stylepack'),
            partBomOutput: findCol(n, 'bomoutput'),
            partParameterEditable: findCol(n, 'parametereditable'),
            partIgnoreInternalInterference: findCol(n, 'ignoreinternalinterference'),
            partResetAfterSuppression: findCol(n, 'resetthepartafterthesuppressionisreleased'),
            partSuppressCondition: findCol(n, 'suppresscondition'),
            // JSON array of {"paramName":...,"value":...} for the child
            // part's own custom parameters (Material/CZ, VGF, or any other
            // paramName that part actually has).
            customParameters: findCol(n, 'customparameters', 'customparameter'),
            // Door Openings (DOOR_OPENING_EDIT) columns. Width/Height,
            // Position X/Y/Z, Rotate X/Y/Z, Position Method, and "Hide
            // Conditions" reuse the exact same idx keys as Parts above
            // (w/h/positionX../partHideCondition) — same header names, same
            // underlying convention, and never both present in one CSV.
            doorOpeningName: findCol(n, 'dooropeningname'),
            doorOpeningType: findCol(n, 'dooropeningtype'),
            doorOpeningAdaptationUnit: findCol(n, 'minimumviableunit', 'adaptationunit')
        };
    }

    const cell = (row, idx) => (idx !== -1 && row[idx] !== undefined) ? row[idx].trim() : '';

    // Every idx.* key that getColumnIndices already resolves to a real Part
    // Edit column. Any CSV column NOT claimed by one of these (and not
    // blank) is a per-part Custom Parameter column instead — see
    // dynamicPartColumns below. Keeping this as an idx-key list (rather
    // than re-deriving header name patterns) means it can never drift out
    // of sync with what getColumnIndices actually matches.
    const PART_FIXED_IDX_KEYS = [
        'serial', 'childSerial', 'partName', 'partRefName', 'styleParameter',
        'w', 'd', 'h', 'positionX', 'positionY', 'positionZ',
        'rotateX', 'rotateY', 'rotateZ', 'positionMethod', 'partHideCondition',
        'partReplaceable', 'partQuotationRequired', 'partRemovable', 'partComponentRemovable',
        'partStylePack', 'partBomOutput', 'partParameterEditable', 'partIgnoreInternalInterference',
        'partResetAfterSuppression', 'partSuppressCondition', 'customParameters'
    ];

    // Part Edit's wide-format Custom Parameters: every column the user adds
    // beyond the fixed set above is one part parameter, keyed by its own
    // column header (e.g. "CB", "CZ") — the header is matched against each
    // part's simpleName first, falling back to paramName, in
    // compilePartEditRow. Computed once per import off the header row
    // (rows[0]) rather than threading a separate headers param everywhere.
    function dynamicPartColumns(rows, idx) {
        const headers = rows[0] || [];
        const claimed = new Set(PART_FIXED_IDX_KEYS.map(k => idx[k]).filter(i => i !== -1 && i !== undefined));
        const cols = [];
        headers.forEach((h, i) => {
            if (claimed.has(i)) return;
            const raw = String(h || '').trim();
            if (!raw) return;
            // A custom-parameter header can be two lines — "Material\nCZ",
            // Extract Parts' displayName-then-code format for legibility.
            // Only the LAST line is the real column key matched against
            // each part's simpleName/paramName; a plain single-line header
            // (no displayName prefix, or hand-typed) passes through as-is.
            const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const header = lines.length > 0 ? lines[lines.length - 1] : raw;
            cols.push({ header, index: i });
        });
        return cols;
    }

    // Parameter type -> allowed Data types (derived from the verified schema table).
    const TYPE_MATRIX = {
        // Unlimited IS allowed for Float/Integer, not just Text — confirmed
        // on real production parameters (SY/XY/ZY/YY/FX/SJ/CZFX/CBCZFX are
        // all Float+Unlimited, paramTypeId 0, in a real editorData sample).
        // Float/Integer/Text all share this same set; only Text lacks Range.
        float: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        integer: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        int: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        float2: ['unlimited', 'advanced formula', 'formula'],
        text: ['unlimited', 'options', 'interval', 'advanced formula', 'formula', 'fixed value'],
        string: ['unlimited', 'options', 'interval', 'advanced formula', 'formula', 'fixed value'],
        boolean: ['unlimited', 'fixed value'],
        'multiple boolean values': ['unlimited', 'fixed value'],
        booleanlist: ['unlimited', 'fixed value'],
        material: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value'],
        contour: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value'],
        style: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value']
    };
    const ASSET_TYPES = ['material', 'style', 'contour'];

    // Width/Depth/Height/Material — the "Basic parameters"/"System
    // parameters" every one of these cabinet/shutter models has, always
    // under these exact refNames, confirmed across every real sample seen.
    // Always structurally referenced (frameModels' own "size" holds
    // "#W"/"#D"/"#H" directly, "materialBrandGoodId" holds "#CZ") — never
    // actually deletable, so PARAM_DEL just skips them rather than
    // attempting (and blocking on) a delete that was never going to work.
    const PROTECTED_PARAM_NAMES = new Set(['W', 'D', 'H', 'CZ']);

    // Position Method's editorOptions are read live off each part (never
    // hardcoded), so whatever language that part's own definition uses is
    // what an exact-name match requires. Some models list these in Chinese
    // even though everything else in the CSV is English. Confirmed pairing
    // (same 3-slot enum, same order/values 0/2/12, seen once in English and
    // once in Chinese on real parts): Origin=原点, Lower Left Rear=左后下,
    // Custom Reference Point=自定义基准点. Used only as a fallback after an
    // exact-name match fails, so English-labeled parts are unaffected.
    const POSITION_METHOD_ALIASES = {
        'origin': ['原点'],
        'lower left rear': ['左后下'],
        'rear lower left': ['左后下'],
        'custom reference point': ['自定义基准点'],
        'custom baseline point': ['自定义基准点'],
        'custom datum point': ['自定义基准点']
    };

    function checkParens(str) {
        const open = (str.match(/\(/g) || []).length;
        const close = (str.match(/\)/g) || []).length;
        return open === close;
    }

    // A cell counts as a formula (skip strict numeric/boolean parsing —
    // just check balanced parens) when it references another parameter via
    // '#' OR another part via '@'. A bare "@Part.field" reference with no
    // '#' anywhere (e.g. Position Z = "@BTS.H", confirmed on a real Tandem
    // Drawer part) is completely valid and was wrongly rejected as
    // "Numeric value or formula expected" when only '#' was checked.
    function isFormulaLike(v) {
        return v.includes('#') || v.includes('@');
    }

    // A {"cases":[...],"defaultValue":...} Condition block with a blank
    // case value or blank defaultValue parses as valid JSON but is invalid
    // to Kujiale's server ("Invalid parameter value") — every case (and
    // the default) needs a real asset id or a '#'/'@' reference, never
    // blank. Reproduced on a real run (VGF's Options Condition block had
    // two blank case values and a blank defaultValue). Returns a list of
    // human-readable labels for whichever entries are blank, or [] if none.
    function findBlankConditionCases(parsed) {
        const blanks = [];
        (parsed.cases || []).forEach((c, ci) => {
            if (c.value === undefined || c.value === null || String(c.value).trim() === '') {
                blanks.push(`case ${ci + 1}${c.condition ? ` (${c.condition})` : ''}`);
            }
        });
        if (parsed.defaultValue === undefined || parsed.defaultValue === null || String(parsed.defaultValue).trim() === '') {
            blanks.push('defaultValue');
        }
        return blanks;
    }

    // =========================================================================
    // SECTION 3: UI CONSTRUCTION (frozen layout)
    // =========================================================================
    const box = document.createElement('div');
    Object.assign(box.style, {
        position: 'fixed', top: '70px', left: '350px', width: '320px',
        backgroundColor: THEME.bg, borderRadius: '12px', border: '1px solid rgba(0,0,0,0.1)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.12)', zIndex: '100000', display: 'flex',
        flexDirection: 'column', fontFamily: '-apple-system, sans-serif', visibility: 'hidden',
        opacity: '0', transition: 'all 0.2s ease-in-out', overflow: 'hidden'
    });

    const header = document.createElement('div');
    header.style.cssText = `display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid ${THEME.border}; cursor:move; user-select:none; background:#fff;`;
    header.innerHTML = '<b style="font-size:10px; color:#1d1d1f; letter-spacing:1px; text-transform:uppercase;">Batch Update <span style="color:#aaa; font-weight:400;">v1.0</span></b>';
    const closeBtn = document.createElement('div'); closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'cursor:pointer; font-size:12px; color:#ccc; font-weight:800;';
    closeBtn.onclick = () => { box.style.visibility = 'hidden'; box.style.opacity = '0'; };
    header.appendChild(closeBtn); box.appendChild(header);

    const body = document.createElement('div'); body.style.padding = '14px'; box.appendChild(body);

    function selectTask(m) {
        if (!m.implemented) {
            showNotification(`⚠️ "${m.label}" is not wired up yet — schema pending.`, THEME.warning);
            return;
        }
        currentTask = m;
        document.getElementById('status-label').innerText = `Target: ${m.label}`;
        document.getElementById('status-label').style.color = m.color;
        document.getElementById('load-btn').disabled = false;
        document.getElementById('load-btn').style.borderColor = m.color;
        resetState();
    }

    function createBtnGroup(title, keys) {
        const sec = document.createElement('div'); sec.style.marginBottom = '12px';
        sec.innerHTML = `<div style="font-size:9px; font-weight:700; color:#aaa; margin-bottom:6px; text-transform:uppercase;">${title}</div>`;
        const grid = document.createElement('div'); grid.style.display = 'grid'; grid.style.gridTemplateColumns = '1fr 1fr'; grid.style.gap = '6px';
        keys.forEach(k => {
            const m = TASK_REGISTRY[k];
            const btn = document.createElement('div');
            const disabledStyle = m.implemented ? '' : 'opacity:0.4; cursor:not-allowed;';
            btn.style.cssText = `padding:6px 8px; border:1px solid #f0f0f2; border-radius:6px; background:#fff; cursor:pointer; font-size:10.5px; display:flex; align-items:center; gap:5px; font-weight:500; ${disabledStyle}`;
            btn.title = m.implemented ? '' : 'Not implemented yet — see chat for schema request.';
            btn.innerHTML = `<span style="color:${m.color}; font-size:12px;">${m.icon}</span> ${m.label}`;
            btn.onclick = () => selectTask(m);
            grid.appendChild(btn);
        });
        sec.appendChild(grid); return sec;
    }

    body.appendChild(createBtnGroup('Quotation Settings', ['QUOTE']));
    body.appendChild(createBtnGroup('Parameters', ['PARAM_EDIT', 'PARAM_DEL']));
    body.appendChild(createBtnGroup('Parts', ['PART_EDIT', 'PART_DEL']));
    body.appendChild(createBtnGroup('Door Openings', ['DOOR_OPENING_EDIT']));

    const panel = document.createElement('div');
    panel.style.cssText = 'padding:10px; background:#f9f9fb; border-radius:8px; border:1px solid #eee;';
    panel.innerHTML = '<div id="status-label" style="font-size:9px; font-weight:700; margin-bottom:6px; color:#ccc">Step 1: Select Logic</div><button id="load-btn" disabled style="width:100%; padding:8px; border:1px dashed #ddd; background:#fff; border-radius:6px; cursor:not-allowed; font-size:11px; font-weight:bold; color:#555;">📂 Import CSV</button>';
    body.appendChild(panel);

    const logBox = document.createElement('div');
    logBox.innerHTML = '<div style="margin:10px 0 4px 0; font-size:9px; font-weight:bold; color:#aaa;">LOG VIEW: <span id="sync-stats" style="float:right; color:#0071e3;">IDLE</span></div><textarea id="log-text" readonly style="width:100%; height:60px; font-family:monospace; font-size:10px; border:1px solid #eee; border-radius:8px; padding:8px; resize:none; outline:none; background:#fff; color:#444; box-sizing:border-box;"></textarea>';
    body.appendChild(logBox);

    const progressLabel = document.createElement('div');
    progressLabel.id = 'progress-label';
    progressLabel.style.cssText = 'font-size:10px; color:#999; margin-top:4px;';
    body.appendChild(progressLabel);

    const footerActions = document.createElement('div');
    footerActions.style.cssText = 'display:grid; grid-template-columns: 1fr 2fr; gap:8px; margin-top:10px;';
    const debugBtn = document.createElement('button'); debugBtn.innerText = '🛠 Debug Query';
    debugBtn.style.cssText = 'padding:10px; border-radius:8px; border:1px solid #eee; background:#fff; color:#666; font-size:11px; font-weight:bold; cursor:pointer;';
    debugBtn.onclick = () => { openDebugger(); };

    const runBtn = document.createElement('button');
    runBtn.id = 'main-run'; runBtn.innerText = 'Run';
    Object.assign(runBtn.style, { padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: '#f0f0f2', color: '#ccc', fontWeight: '800', fontSize: '11px', cursor: 'not-allowed', pointerEvents: 'none' });

    footerActions.appendChild(debugBtn); footerActions.appendChild(runBtn);
    body.appendChild(footerActions);

    const errorBtn = document.createElement('button');
    errorBtn.id = 'error-download';
    errorBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #ff4d4f; color:#ff4d4f; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    errorBtn.innerText = '📥 Download Format Errors';
    errorBtn.onclick = () => { downloadCsvReport(preValidationErrors, 'csv_validation_errors', ['Row', 'Model ID', 'Parameter Name', 'Column', 'Error', 'Suggested Fix'], e => [e.row, e.serial, e.refName, e.col, e.msg, e.fix || '']); };
    body.appendChild(errorBtn);

    const runErrorBtn = document.createElement('button');
    runErrorBtn.id = 'run-error-download';
    runErrorBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #ff9f0a; color:#ff9f0a; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    runErrorBtn.innerText = '📥 Download Run Errors';
    runErrorBtn.onclick = () => { downloadCsvReport(lastRunErrors, 'batch_run_errors', ['Model ID', 'Error'], e => [e.id, e.msg]); };
    body.appendChild(runErrorBtn);

    const extractBtn = document.createElement('button');
    extractBtn.id = 'extract-params-btn';
    extractBtn.style.cssText = 'width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #0071e3; color:#0071e3; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    extractBtn.innerText = '📤 Extract Parameters / Parts to Sheet';
    extractBtn.onclick = () => { openExtractor(); };
    body.appendChild(extractBtn);

    document.body.appendChild(box);

    const trigger = document.createElement('button');
    trigger.innerText = 'Batch Update';
    Object.assign(trigger.style, { position: 'fixed', top: '10px', left: '350px', zIndex: '99999', padding: '6px 12px', backgroundColor: '#1d1d1f', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' });
    trigger.onclick = () => { box.style.visibility = (box.style.visibility === 'visible' ? 'hidden' : 'visible'); box.style.opacity = (box.style.opacity === '1' ? '0' : '1'); };
    document.body.appendChild(trigger);

    // secondHeaderRow is optional — Extract Parts uses it for a REAL second
    // header row (row 1 = human-readable DisplayName labels, row 2 = the
    // actual codes matched on import; see the loader's multi-header-row
    // detection below), every other export just passes one header row.
    function downloadCsvReport(items, filenamePrefix, headerRow, rowMapper, extraHeaderRows) {
        if (!items || items.length === 0) return;
        // Quoted the same as every data cell (not just joined raw) — a
        // header can itself contain a comma, and only a quoted field
        // survives that intact through RFC4180 parsing/Excel instead of
        // corrupting the row.
        const quoteCells = (arr) => arr.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',');
        let csv = "﻿" + quoteCells(headerRow) + "\n";
        (extraHeaderRows || []).forEach(r => { csv += quoteCells(r) + "\n"; });
        items.forEach(item => {
            csv += quoteCells(rowMapper(item)) + "\n";
        });
        const b = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(b);
        const a = document.createElement('a'); a.href = url;
        a.download = `${filenamePrefix}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // SECTION 4: CSV IMPORT & PRE-VALIDATION
    // =========================================================================
    const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.csv'; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    document.getElementById('load-btn').onclick = () => { fileInput.click(); };

    function resetState() {
        parsedData = null; preValidationErrors = []; lastRunErrors = [];
        document.getElementById('log-text').value = '';
        document.getElementById('error-download').style.display = 'none';
        document.getElementById('run-error-download').style.display = 'none';
        document.getElementById('progress-label').innerText = '';
        runBtn.disabled = true; runBtn.style.backgroundColor = '#f0f0f2'; runBtn.style.pointerEvents = 'none';
        document.getElementById('sync-stats').innerText = 'IDLE';
    }

    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (f) => {
            const rawRows = Utils.parseCSV(f.target.result);
            if (!rawRows || rawRows.length < 2) { showNotification('❌ Empty or invalid CSV.', THEME.danger); return; }

            // Extract Parts' Custom Parameters sheet can carry OPTIONAL
            // extra header rows above the real one (currently 3 total:
            // Group Name, then Parameter Name / DisplayName, then
            // Reference name / code — the last is what's actually matched
            // below). The fixed columns (Product serial number, Width, ...)
            // are only populated on that real header row — blank on the
            // rows above it — so the real header is found by scanning down
            // for the first row that contains "Product serial number"
            // ANYWHERE in it (not pinned to a specific column, so column
            // order doesn't matter); everything above that row is dropped.
            // A single-header-row CSV (older exports, or hand-typed) already
            // has it on row 1, so this is a no-op for those.
            let rows = rawRows;
            const headerRowIndex = rawRows.findIndex(r => r.some(c => Utils.normHeader(c) === 'productserialnumber'));
            if (headerRowIndex > 0) {
                rows = [rawRows[headerRowIndex], ...rawRows.slice(headerRowIndex + 1)];
            }

            const headers = rows[0];
            const idx = getColumnIndices(headers);

            preValidationErrors = [];
            if (currentTask.id === 'QUOTE') {
                validateQuoteHeaders(idx);
            } else if (currentTask.id === 'PARAM_EDIT') {
                validateParamEditHeaders(idx);
            } else if (currentTask.id === 'PARAM_DEL') {
                validateParamDelHeaders(idx);
            } else if (currentTask.id === 'PART_EDIT') {
                validatePartEditHeaders(idx);
            } else if (currentTask.id === 'PART_DEL') {
                validatePartDelHeaders(idx);
            } else if (currentTask.id === 'DOOR_OPENING_EDIT') {
                validateDoorOpeningHeaders(idx);
            }

            // Header errors (missing required COLUMN) block everything —
            // there's no well-formed row to partially salvage. Row errors
            // are different: only the offending rows get skipped below,
            // every clean row still runs.
            const headerErrorCount = preValidationErrors.length;

            if (headerErrorCount === 0) {
                if (currentTask.id === 'QUOTE') validateQuoteRows(rows, idx);
                else if (currentTask.id === 'PARAM_EDIT') validateParamEditRows(rows, idx);
                else if (currentTask.id === 'PARAM_DEL') validateParamDelRows(rows, idx);
                else if (currentTask.id === 'PART_EDIT') validatePartEditRows(rows, idx);
                else if (currentTask.id === 'PART_DEL') validatePartDelRows(rows, idx);
                else if (currentTask.id === 'DOOR_OPENING_EDIT') validateDoorOpeningRows(rows, idx);
            }

            if (headerErrorCount > 0) {
                document.getElementById('log-text').value = `❌ Found ${preValidationErrors.length} header error(s). Download report, fix, and re-import.`;
                document.getElementById('error-download').style.display = 'block';
                showNotification(`❌ ${preValidationErrors.length} validation error(s) found.`, THEME.danger);
                parsedData = null;
                return;
            }

            // "@XYZ" references another part instance by its Reference
            // name (e.g. @VG.H) — a real run failed server-side with
            // "undefined variable reference" because @VG wasn't actually a
            // part in that model yet. Checked live against each referenced
            // model's actual parts before Run, same idea as the .gs sheet's
            // "#XYZ" check but for real server state instead of just the
            // CSV's own contents (only possible here since this path can
            // make network calls; CSV-only pre-validation can't).
            if (currentTask.id === 'PARAM_EDIT' || currentTask.id === 'PART_EDIT' || currentTask.id === 'DOOR_OPENING_EDIT') {
                document.getElementById('log-text').value = `Checking part references...`;
                await checkAtReferences(rows, idx);
            }

            const errorRows = new Set(preValidationErrors.filter(e => typeof e.row === 'number').map(e => e.row));
            parsedData = buildDataMap(currentTask.id, rows, idx, errorRows);
            const protectedNote = lastDeleteSkippedProtected.length > 0
                ? ` (${lastDeleteSkippedProtected.length} system parameter(s) [${[...new Set(lastDeleteSkippedProtected)].join(', ')}] always kept — skipped, not an error.)`
                : '';
            if (parsedData.size === 0) {
                document.getElementById('log-text').value = `❌ Every row had an error — nothing to run. Download report, fix, and re-import.`;
                document.getElementById('error-download').style.display = 'block';
                showNotification(`❌ ${preValidationErrors.length} validation error(s) found — no valid rows.`, THEME.danger);
                parsedData = null;
            } else if (errorRows.size > 0) {
                document.getElementById('log-text').value = `⚠️ ${preValidationErrors.length} error(s) on ${errorRows.size} row(s) — those rows are skipped. ${parsedData.size} model(s) ready to run.${protectedNote}`;
                document.getElementById('error-download').style.display = 'block';
                runBtn.disabled = false; runBtn.style.backgroundColor = THEME.textMain; runBtn.style.color = '#fff'; runBtn.style.pointerEvents = 'auto'; runBtn.style.cursor = 'pointer';
                showNotification(`⚠️ ${errorRows.size} row(s) skipped (errors) — ${parsedData.size} model(s) still ready.`, THEME.warning);
            } else {
                document.getElementById('log-text').value = `✅ ${parsedData.size} model(s) validated. Press Run.${protectedNote}`;
                document.getElementById('error-download').style.display = 'none';
                runBtn.disabled = false; runBtn.style.backgroundColor = THEME.textMain; runBtn.style.color = '#fff'; runBtn.style.pointerEvents = 'auto'; runBtn.style.cursor = 'pointer';
                showNotification(`✅ ${parsedData.size} model(s) ready to run.${lastDeleteSkippedProtected.length > 0 ? ' System params kept.' : ''}`, THEME.success);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    // Scans every non-blank row for "@name" references, fetches each
    // referenced model ONCE (grouped by Product serial number), and flags
    // any reference that doesn't match a real part's Reference name —
    // pushed into preValidationErrors exactly like a normal row error, so
    // the row gets skipped the same way any other pre-validation failure
    // does (see errorRows below).
    async function checkAtReferences(rows, idx) {
        // Whichever of these columns exists identifies "this row" in the
        // error report — Parameter Name for a Parameter CSV, Part Name for
        // a Parts CSV, Door Opening Name for a Door Openings CSV.
        const nameCol = idx.paramName !== -1 ? idx.paramName : (idx.partName !== -1 ? idx.partName : idx.doorOpeningName);
        const rowRefs = []; // {rowNum, serial, rowName, names: Set}
        const serials = new Set();
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const serial = cell(row, idx.serial);
            if (!serial) continue;
            const names = new Set();
            row.forEach(v => {
                const matches = String(v || '').match(/@[a-zA-Z0-9_]+/g) || [];
                matches.forEach(m => {
                    const name = m.slice(1);
                    // "@self..." is Kujiale's own self-reference token — a
                    // part referring to ITS OWN Reference name from inside
                    // its own formula (e.g. "@selfTDMDR1" inside part
                    // TDMDR1's own Position Y), not a reference to some
                    // OTHER part literally named "selfTDMDR1" (which would
                    // never exist). Always valid — skip it rather than
                    // flagging a false "doesn't match any part" error.
                    if (/^self/i.test(name)) return;
                    names.add(name);
                });
            });
            if (names.size > 0) {
                rowRefs.push({ rowNum: i + 1, serial, rowName: cell(row, nameCol), names });
                serials.add(serial);
            }
        }
        if (serials.size === 0) return;

        const refNamesBySerial = new Map();
        await Promise.all([...serials].map(async serial => {
            try {
                refNamesBySerial.set(serial, await fetchModelRefNames(serial));
            } catch (e) {
                // Can't verify — model fetch failed (deleted, no access,
                // network). Don't block the row over a lookup failure
                // that's unrelated to the CSV's own content; Run will
                // still hit the same fetch and surface it there if it's
                // a real problem.
                refNamesBySerial.set(serial, null);
            }
        }));

        rowRefs.forEach(({ rowNum, serial, rowName, names }) => {
            const known = refNamesBySerial.get(serial);
            if (!known) return;
            const missing = [...names].filter(n => !known.has(n));
            if (missing.length > 0) {
                addErr(rowNum, serial, rowName, 'Reference', `${missing.map(n => '@' + n).join(', ')} doesn't match any part's Reference name in model '${serial}' — add that part first (with a matching Reference name), or check for a typo.`);
            }
        });
    }

    async function fetchModelRefNames(serial) {
        const origin = window.location.origin;
        const tool = currentToolType();
        const resp = await fetch(`${origin}/editor/api/site/editordata?obsbrandgoodid=${encodeURIComponent(serial)}&tooltype=${tool}`, { headers: { accept: '*/*', 'editor-locale': 'zh_CN' }, credentials: 'include' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const json = await resp.json();
        const ed = json.editorData;
        if (!ed) throw new Error('no editorData in response');
        return new Set((ed.modelInstances || []).map(mi => mi.refName).filter(Boolean));
    }

    function addErr(row, serial, refName, col, msg, fix) {
        preValidationErrors.push({ row, serial: serial || '', refName: refName || '', col, msg, fix: fix || '' });
    }

    function validateQuoteHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        if (idx.w === -1 && idx.d === -1 && idx.h === -1) {
            addErr('Header', '', '', 'Model Width/Depth/Height', "At least one of 'Model Width', 'Model Depth', 'Model Height' is required.");
        }
    }
    function validateParamEditHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        if (idx.paramName === -1) addErr('Header', '', '', 'Parameter Name', "Missing required column 'Parameter Name'.");
        if (idx.displayName === -1) addErr('Header', '', '', 'Display Name', "Missing required column 'Display Name'.");
        if (idx.grouping === -1) addErr('Header', '', '', 'Grouping', "Missing required column 'Grouping'.");
    }
    function validateParamDelHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        if (idx.paramName === -1) addErr('Header', '', '', 'Parameter Name', "Missing required column 'Parameter Name'.");
    }
    function validatePartEditHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        if (idx.childSerial === -1) addErr('Header', '', '', 'Child Serial Number', "Missing required column 'Child Serial Number'.");
        if (idx.partName === -1) addErr('Header', '', '', 'Part Name', "Missing required column 'Part Name'.");
    }
    function validatePartDelHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        // Reference name isn't on every part — some are added without one.
        // Child Serial Number and Part Name are the fallback identifiers, so
        // at least one of the three columns has to exist, not Reference
        // name specifically.
        if (idx.childSerial === -1 && idx.partName === -1 && idx.partRefName === -1) {
            addErr('Header', '', '', 'Child Serial Number / Part Name / Reference name', "At least one of 'Child Serial Number', 'Part Name', or 'Reference name' columns is required.");
        }
    }
    function validateDoorOpeningHeaders(idx) {
        if (idx.serial === -1) addErr('Header', '', '', 'Product serial number', "Missing required column 'Product serial number'.");
        if (idx.doorOpeningName === -1) addErr('Header', '', '', 'Door Opening Name', "Missing required column 'Door Opening Name'.");
    }

    function validateQuoteRows(rows, idx) {
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            if (!serial) { addErr(rowNum, 'Empty', '', 'Product serial number', 'Model serial ID is empty.'); continue; }
            // Width/Depth/Height accept either a plain number or a formula
            // referencing another parameter (e.g. "#W", "#D * 2") — customSize
            // is commonly set to a self-reference like {"x":"#H","y":"#W","z":"#D"}.
            [['w', idx.w], ['d', idx.d], ['h', idx.h]].forEach(([label, ix]) => {
                const v = cell(row, ix);
                if (!v) return;
                if (isFormulaLike(v)) {
                    if (!checkParens(v)) addErr(rowNum, serial, '', label.toUpperCase(), `Unbalanced parentheses in formula '${v}'.`);
                } else if (isNaN(Number(v))) {
                    addErr(rowNum, serial, '', label.toUpperCase(), `Non-numeric value '${v}'.`);
                }
            });
        }
    }

    function validateParamDelRows(rows, idx) {
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            const refName = cell(row, idx.paramName);
            if (!serial) addErr(rowNum, 'Empty', refName, 'Product serial number', 'Model serial ID is empty.');
            if (!refName) addErr(rowNum, serial, 'Empty', 'Parameter Name', 'Parameter Name is empty.');
        }
    }

    function validatePartEditRows(rows, idx) {
        const seenPerModel = new Map();
        const seenRefNamePerModel = new Map();
        const dynCols = dynamicPartColumns(rows, idx);
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            const childSerial = cell(row, idx.childSerial);
            const partName = cell(row, idx.partName);
            const partRefName = cell(row, idx.partRefName);
            if (!serial) addErr(rowNum, 'Empty', partName, 'Product serial number', 'Model serial ID is empty.');
            // Child Serial Number is NOT required unconditionally — a blank
            // Reference name AND Part Name that both fail to match any
            // existing part is the only case that actually needs it (to
            // fetch a new catalog part), and whether that happens can only
            // be known against the live model at Run time (e.g. a self-
            // modeled/custom-geometry part has no catalog id of its own to
            // begin with, and is only ever edited, never added — see
            // compilePartEditRow's own guard for the real error there).
            if (!partName) addErr(rowNum, serial, '', 'Part Name', 'Part Name is required.');
            // Reference name itself is optional (confirmed) — but when given,
            // it must be unique per model, same as Parameter Name is for
            // PARAM_EDIT (checked live at Run too, but catching it here means
            // both offending rows show up together instead of the run
            // stopping cold on whichever row hits it first server-side).

            // Same Child Serial Number + Part Name repeated for the same
            // target model — almost certainly a copy-paste duplicate row,
            // not two intentionally-separate parts. NOTE: this only catches
            // duplicates WITHIN the CSV itself; it can't see parts already
            // present in the live model (that would need a network call
            // during pre-validation, which this pass doesn't do).
            if (serial && childSerial && partName) {
                if (!seenPerModel.has(serial)) seenPerModel.set(serial, new Set());
                const set = seenPerModel.get(serial);
                const key = childSerial + '|' + partName;
                if (set.has(key)) addErr(rowNum, serial, partName, 'Child Serial Number', `Duplicate part — Child Serial Number '${childSerial}' with Part Name '${partName}' already appears earlier in this CSV for this model.`);
                else set.add(key);
            }

            // Same Reference name reused across different rows for the same
            // model (e.g. Top Shelf / TPS and Bottom Shelf / TPS) — flag
            // BOTH rows, not just the later one, so the report shows the
            // whole conflict at a glance.
            if (serial && partRefName) {
                if (!seenRefNamePerModel.has(serial)) seenRefNamePerModel.set(serial, new Map());
                const refMap = seenRefNamePerModel.get(serial);
                if (refMap.has(partRefName)) {
                    const first = refMap.get(partRefName);
                    if (!first.flagged) {
                        addErr(first.rowNum, serial, partRefName, 'Reference name', `Duplicate Reference name '${partRefName}' found — also used on row ${rowNum} for this model.`);
                        first.flagged = true;
                    }
                    addErr(rowNum, serial, partRefName, 'Reference name', `Duplicate Reference name '${partRefName}' found — also used on row ${first.rowNum} for this model.`);
                } else {
                    refMap.set(partRefName, { rowNum: rowNum, flagged: false });
                }
            }

            // Style Parameter (functionName) and Style Pack (modelPackage)
            // are mutually exclusive — confirmed on a real sample: Shutter 1
            // has functionName "#SD1" (a reference to another instance) and
            // modelPackage null; Shutter 2/3 have a real standalone
            // functionName and a real modelPackage value. A part can't be
            // both "delegate to another instance" and "have its own style
            // pack" at once.
            const styleParameter = cell(row, idx.styleParameter);
            const partStylePack = cell(row, idx.partStylePack);
            if (styleParameter && partStylePack) {
                addErr(rowNum, serial, partName, 'Style Pack', `Style Parameter and Style Pack cannot both have a value on the same row — leave Style Pack empty when Style Parameter is set (or vice versa).`);
            }
            if (partStylePack && partStylePack.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(partStylePack);
                    if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) {
                        throw new Error('expected {"cases":[...],"defaultValue":...}');
                    }
                    const blanks = findBlankConditionCases(parsed);
                    if (blanks.length > 0) {
                        addErr(rowNum, serial, partName, 'Style Pack', `Style Pack has a blank value for ${blanks.join(', ')} — every case (and defaultValue) needs a real style-pack id, not blank.`);
                    }
                } catch (e) {
                    addErr(rowNum, serial, partName, 'Style Pack', `Style Pack looks like JSON but isn't a valid {"cases":[...],"defaultValue":...} block: ${e.message}`);
                }
            }

            // "Reset the part after the suppression is released" is
            // strictly boolean (confirmed — corrected from the general
            // "or formula" note that applied to the other Design Attribute
            // fields but not this one).
            const resetAfterSuppression = cell(row, idx.partResetAfterSuppression);
            if (resetAfterSuppression && !['true', 'false'].includes(resetAfterSuppression.toLowerCase())) {
                addErr(rowNum, serial, partName, 'Reset the part after the suppression is released', `Must be true or false, got '${resetAfterSuppression}'.`);
            }

            // Boolean-ish part attributes — literal true/false, OR a formula
            // (contains '#', confirmed acceptable per your mapping notes).
            [
                ['partHideCondition', 'Hide Conditions'],
                ['partReplaceable', 'Replaceable'],
                ['partQuotationRequired', 'Quotation Required'],
                ['partRemovable', 'Removable'],
                ['partComponentRemovable', 'Component Removable'],
                ['partBomOutput', 'BOM Output'],
                ['partParameterEditable', 'Parameter Editable'],
                ['partIgnoreInternalInterference', 'Ignore Internal Interference'],
                ['partSuppressCondition', 'Suppress condition']
            ].forEach(([key, label]) => {
                const v = cell(row, idx[key]);
                if (!v) return;
                if (isFormulaLike(v)) {
                    if (!checkParens(v)) addErr(rowNum, serial, partName, label, 'Unbalanced parentheses.');
                } else if (!['true', 'false'].includes(v.toLowerCase())) {
                    addErr(rowNum, serial, partName, label, `Must be true, false, or a formula (containing '#' or '@'), got '${v}'.`);
                }
            });

            // Position Method — a whole number, a formula, OR an option
            // NAME (e.g. "Lower Left Rear") resolved against the actual
            // part's own editorOptions at Run time — the numeric mapping
            // isn't hardcoded here on purpose (see compilePartEditRow),
            // since it's read live off each part's own definition rather
            // than assumed. Pre-validation can only rule out the formula
            // case here; name validity needs the imported part, so it's
            // deferred to Run.
            const positionMethod = cell(row, idx.positionMethod);
            if (positionMethod && isFormulaLike(positionMethod) && !checkParens(positionMethod)) {
                addErr(rowNum, serial, partName, 'Position Method', 'Unbalanced parentheses.');
            }

            // Width/Depth/Height and Position/Rotate X/Y/Z — numeric, OR a
            // formula. Whether a given part's W/D/H is even settable
            // (paramTypeId 5 = Formula-driven internally, not overridable
            // from the parent) can only be checked at Run time against the
            // freshly-imported part definition — flagged there instead.
            [
                ['w', 'Width'], ['d', 'Depth'], ['h', 'Height'],
                ['positionX', 'PositionX'], ['positionY', 'PositionY'], ['positionZ', 'PositionZ'],
                ['rotateX', 'RotateX'], ['rotateY', 'RotateY'], ['rotateZ', 'RotateZ']
            ].forEach(([key, label]) => {
                const v = cell(row, idx[key]);
                if (!v) return;
                if (isFormulaLike(v)) {
                    if (!checkParens(v)) addErr(rowNum, serial, partName, label, 'Unbalanced parentheses.');
                } else if (isNaN(Number(v))) {
                    addErr(rowNum, serial, partName, label, `Numeric value or formula expected, got '${v}'.`);
                }
            });

            // Custom Parameters — JSON array of {"paramName":...,"value":...}.
            // Whether a given paramName actually exists on the imported
            // part, and whether its value is a valid Condition JSON, can
            // only be checked at Run time (needs the part's own definition)
            // — this only checks the array/entry SHAPE is well-formed.
            const customParameters = cell(row, idx.customParameters);
            if (customParameters) {
                try {
                    const parsed = JSON.parse(customParameters);
                    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
                    parsed.forEach((entry, i) => {
                        if (!entry || typeof entry !== 'object' || !entry.paramName) throw new Error(`entry ${i} missing "paramName"`);
                    });
                    parsed.forEach(entry => {
                        const v = entry.value !== undefined && entry.value !== null ? String(entry.value).trim() : '';
                        if (v.startsWith('{') && v.includes('"cases"')) {
                            try {
                                const condParsed = JSON.parse(v);
                                if (condParsed && Array.isArray(condParsed.cases) && condParsed.defaultValue !== undefined) {
                                    const blanks = findBlankConditionCases(condParsed);
                                    if (blanks.length > 0) {
                                        addErr(rowNum, serial, partName, 'Custom Parameters', `'${entry.paramName}' has a blank value for ${blanks.join(', ')} — every case (and defaultValue) needs a real value, not blank.`);
                                    }
                                }
                            } catch (e) { /* malformed JSON here is reported at Run time against the real part */ }
                        }
                    });
                } catch (e) {
                    addErr(rowNum, serial, partName, 'Custom Parameters', `Not a valid JSON array of {"paramName":...,"value":...}: ${e.message}`);
                }
            }

            // Wide-format Custom Parameters — one column per part
            // parameter (header = simpleName or paramName, e.g. "CB",
            // "CZ"). Whether the header actually matches a real parameter
            // on the imported part can only be checked at Run time; this
            // only validates a Condition-JSON cell's shape, same as the
            // legacy JSON-array column above.
            dynCols.forEach(({ header, index }) => {
                const v = row[index] !== undefined ? row[index].trim() : '';
                if (!v || !v.startsWith('{') || !v.includes('"cases"')) return;
                try {
                    const condParsed = JSON.parse(v);
                    if (!condParsed || !Array.isArray(condParsed.cases) || condParsed.defaultValue === undefined) {
                        throw new Error('expected {"cases":[...],"defaultValue":...}');
                    }
                    const blanks = findBlankConditionCases(condParsed);
                    if (blanks.length > 0) {
                        addErr(rowNum, serial, partName, header, `'${header}' has a blank value for ${blanks.join(', ')} — every case (and defaultValue) needs a real value, not blank.`);
                    }
                } catch (e) {
                    addErr(rowNum, serial, partName, header, `'${header}' looks like JSON but isn't a valid {"cases":[...],"defaultValue":...} block: ${e.message}`);
                }
            });
        }
    }

    function validatePartDelRows(rows, idx) {
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            const childSerial = cell(row, idx.childSerial);
            const partName = cell(row, idx.partName);
            const partRefName = cell(row, idx.partRefName);
            if (!serial) addErr(rowNum, 'Empty', partRefName || partName, 'Product serial number', 'Model serial ID is empty.');
            // At least one identifier — Reference name is the most precise
            // (exact match), Child Serial Number + Part Name are the
            // fallback for parts that were never given a Reference name.
            if (!childSerial && !partName && !partRefName) {
                addErr(rowNum, serial, '', 'Child Serial Number / Part Name / Reference name', 'At least one of Child Serial Number, Part Name, or Reference name is required to identify which part to delete.');
            }
        }
    }

    function validateDoorOpeningRows(rows, idx) {
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            const name = cell(row, idx.doorOpeningName);
            if (!serial) addErr(rowNum, 'Empty', name, 'Product serial number', 'Model serial ID is empty.');
            if (!name) {
                addErr(rowNum, serial, '', 'Door Opening Name', 'Door Opening Name is required — must exactly match an existing Door Opening on the model (e.g. "Door Opening-1"). This sheet edits existing Door Openings only, it can\'t create new ones.');
            }

            // Width/Height and Position/Rotate X/Y/Z — numeric, or a formula
            // (same convention as Parts' own W/D/H and Position/Rotate).
            [
                ['w', 'Width'], ['h', 'Height'],
                ['positionX', 'Position X'], ['positionY', 'Position Y'], ['positionZ', 'Position Z'],
                ['rotateX', 'Rotate X'], ['rotateY', 'Rotate Y'], ['rotateZ', 'Rotate Z']
            ].forEach(([key, label]) => {
                const v = cell(row, idx[key]);
                if (!v) return;
                if (isFormulaLike(v)) {
                    if (!checkParens(v)) addErr(rowNum, serial, name, label, 'Unbalanced parentheses.');
                } else if (isNaN(Number(v))) {
                    addErr(rowNum, serial, name, label, `Numeric value or formula expected, got '${v}'.`);
                }
            });

            const hideCondition = cell(row, idx.partHideCondition);
            if (hideCondition) {
                if (isFormulaLike(hideCondition)) {
                    if (!checkParens(hideCondition)) addErr(rowNum, serial, name, 'Hide Conditions', 'Unbalanced parentheses.');
                } else if (!['true', 'false'].includes(hideCondition.toLowerCase())) {
                    addErr(rowNum, serial, name, 'Hide Conditions', `Must be true, false, or a formula (containing '#' or '@'), got '${hideCondition}'.`);
                }
            }

            // Position Method / Door Opening Type — whichever option NAME
            // (or raw enum value) was typed is only resolved against the
            // real Door Opening's own editorOptions at Run time (see
            // compileDoorOpeningRow); pre-validation can only catch an
            // unbalanced formula here.
            const positionMethod = cell(row, idx.positionMethod);
            if (positionMethod && isFormulaLike(positionMethod) && !checkParens(positionMethod)) {
                addErr(rowNum, serial, name, 'Position Method', 'Unbalanced parentheses.');
            }

            const adaptationUnit = cell(row, idx.doorOpeningAdaptationUnit);
            if (adaptationUnit && !['true', 'false'].includes(adaptationUnit.toLowerCase())) {
                addErr(rowNum, serial, name, 'Minimum viable unit', `Must be true or false, got '${adaptationUnit}'.`);
            }
        }
    }

    function validateParamEditRows(rows, idx) {
        const seenPerModel = new Map();
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;

            const serial = cell(row, idx.serial);
            const refName = cell(row, idx.paramName);
            const displayName = cell(row, idx.displayName);
            const grouping = cell(row, idx.grouping);
            const paramCategory = cell(row, idx.paramCategory);
            const globalId = cell(row, idx.globalId);
            const isGlobalRow = paramCategory.toLowerCase() === 'global' || !!globalId;

            if (!serial) addErr(rowNum, 'Empty', refName, 'Product serial number', 'Model serial ID is empty.');
            if (!refName) {
                addErr(rowNum, serial, 'Empty', 'Parameter Name', 'Parameter Name is required.');
            } else if (!/^[a-zA-Z0-9_]+$/.test(refName)) {
                addErr(rowNum, serial, refName, 'Parameter Name', 'Parameter Name must be alphanumeric/underscore only.');
            } else if (serial) {
                if (!seenPerModel.has(serial)) seenPerModel.set(serial, new Set());
                const set = seenPerModel.get(serial);
                if (set.has(refName)) addErr(rowNum, serial, refName, 'Parameter Name', `Duplicate '${refName}' for this model — combine into one row instead.`);
                else set.add(refName);
            }
            if (!displayName) addErr(rowNum, serial, refName, 'Display Name', 'Display Name is required.');
            if (!grouping) addErr(rowNum, serial, refName, 'Grouping', 'Grouping is required.');

            const imosOutputCondition = cell(row, idx.imosOutputCondition);
            if (imosOutputCondition && !checkParens(imosOutputCondition)) {
                addErr(rowNum, serial, refName, 'IMOS Output Condition', 'Unbalanced parentheses.');
            }

            if (isGlobalRow) { row.__optionsParsed = null; row.__expressionParsed = null; continue; }

            const pType = cell(row, idx.paramType).toLowerCase();
            const dType = cell(row, idx.dataType).toLowerCase();
            const value = cell(row, idx.value);
            const min = cell(row, idx.min);
            const max = cell(row, idx.max);
            const compositeType = cell(row, idx.compositeType).toLowerCase();
            const valueRelationship = cell(row, idx.valueRelationship).toLowerCase();
            const defaultState = cell(row, idx.defaultState).toLowerCase();
            const materialRange = cell(row, idx.materialRange).toLowerCase();
            const expressionType = cell(row, idx.expressionType).toLowerCase();
            const optionsRaw = cell(row, idx.options);
            const expressionRaw = cell(row, idx.expression);
            const hideCondition = cell(row, idx.hideCondition);

            if (!pType) {
                addErr(rowNum, serial, refName, 'Parameter type', 'Parameter type is required.');
            } else if (!TYPE_MATRIX[pType]) {
                addErr(rowNum, serial, refName, 'Parameter type', `Unknown Parameter type '${cell(row, idx.paramType)}'.`, `Choose from: ${Object.keys(TYPE_MATRIX).join(', ')}.`);
            }
            if (!dType) {
                addErr(rowNum, serial, refName, 'Data type', 'Data type is required.');
            } else if (TYPE_MATRIX[pType] && !TYPE_MATRIX[pType].includes(dType)) {
                addErr(rowNum, serial, refName, 'Data type', `'${cell(row, idx.dataType)}' is not valid for Parameter type '${cell(row, idx.paramType)}'.`, `Allowed: ${TYPE_MATRIX[pType].join(', ')}.`);
            }

            const isAsset = ASSET_TYPES.includes(pType);

            if (pType === 'boolean' && value) {
                const lv = value.toLowerCase();
                if (!['true', 'false', '0', '1'].includes(lv)) addErr(rowNum, serial, refName, 'Value', "Boolean value must be true/false/0/1.");
            }
            if (['float', 'integer', 'int'].includes(pType) && dType === 'fixed value' && value && isNaN(Number(value))) {
                addErr(rowNum, serial, refName, 'Value', `Numeric value expected, got '${value}'.`);
            }

            if (!isAsset && (dType === 'range' || dType === 'interval')) {
                if (!min) addErr(rowNum, serial, refName, 'Minimum', 'Minimum is required for Range/Interval.');
                if (!max) addErr(rowNum, serial, refName, 'Maximum', 'Maximum is required for Range/Interval.');
            }

            // Composite type / Value relationships: Float, Integer, Text, Float2 only.
            if (!isAsset && dType === 'advanced formula') {
                if (!compositeType) {
                    addErr(rowNum, serial, refName, 'Composite type', "Composite type is required for Advanced Formula.", "Enter 'Range' or 'Options'.");
                } else if (!['range', 'options'].includes(compositeType)) {
                    addErr(rowNum, serial, refName, 'Composite type', `Invalid Composite type '${cell(row, idx.compositeType)}'.`, "Enter 'Range' or 'Options'.");
                }
                if (!valueRelationship) {
                    addErr(rowNum, serial, refName, 'Value relationships', 'Value relationships is required for Advanced Formula.', "Enter 'Outside' or 'Within'.");
                } else if (!['outside', 'within'].includes(valueRelationship)) {
                    addErr(rowNum, serial, refName, 'Value relationships', `Invalid Value relationships '${cell(row, idx.valueRelationship)}'.`, "Enter 'Outside' or 'Within'.");
                }
                if (compositeType === 'range') {
                    if (!min) addErr(rowNum, serial, refName, 'Minimum', 'Minimum is required for Advanced Formula + Range.');
                    if (!max) addErr(rowNum, serial, refName, 'Maximum', 'Maximum is required for Advanced Formula + Range.');
                }
            }

            // Range Type / Expression Type: Material, Style, Contour only.
            if (isAsset && (dType === 'options' || dType === 'advanced formula')) {
                if (!materialRange) {
                    addErr(rowNum, serial, refName, 'Range Type', 'Range Type is required for Options / Advanced Formula on Material, Style, or Contour.', "Enter 'Select' or 'Condition'.");
                } else if (!['select', 'condition'].includes(materialRange)) {
                    addErr(rowNum, serial, refName, 'Range Type', `Invalid Range Type '${cell(row, idx.materialRange)}'.`, "Enter 'Select' or 'Condition'.");
                }
            }
            if (isAsset && (dType === 'formula' || dType === 'advanced formula')) {
                if (!expressionType) {
                    addErr(rowNum, serial, refName, 'Expression Type', 'Expression Type is required for Formula / Advanced Formula on Material, Style, or Contour.', "Enter 'Reference' or 'Condition'.");
                } else if (!['reference', 'condition'].includes(expressionType)) {
                    addErr(rowNum, serial, refName, 'Expression Type', `Invalid Expression Type '${cell(row, idx.expressionType)}'.`, "Enter 'Reference' or 'Condition'.");
                }
            }
            // Default state applies to Advanced Formula regardless of asset-ness.
            if (dType === 'advanced formula') {
                if (!defaultState) {
                    addErr(rowNum, serial, refName, 'Default state', 'Default state is required for Advanced Formula.', "Enter 'Value' or 'Formula'.");
                } else if (!['value', 'formula'].includes(defaultState)) {
                    addErr(rowNum, serial, refName, 'Default state', `Invalid Default state '${cell(row, idx.defaultState)}'.`, "Enter 'Value' or 'Formula'.");
                }
            }

            if (!isAsset && dType === 'advanced formula' && !expressionRaw) {
                addErr(rowNum, serial, refName, 'Expression', 'Expression is required for Advanced Formula.');
            }
            if (dType === 'formula' && !expressionRaw) {
                addErr(rowNum, serial, refName, 'Expression', 'Expression is required for Formula.');
            }
            if (isAsset && dType === 'advanced formula' && expressionType && !expressionRaw) {
                addErr(rowNum, serial, refName, 'Expression', 'Expression is required for Advanced Formula.');
            }

            let optionsParsed = null;
            let expressionParsed = null;

            if (!isAsset) {
                if (dType === 'options' || (dType === 'advanced formula' && compositeType === 'options')) {
                    if (!optionsRaw) {
                        addErr(rowNum, serial, refName, 'Options', 'Options is required for this Data type.', 'Provide a JSON array, e.g. [{"name":"A","value":"1"}].');
                    } else {
                        try {
                            optionsParsed = JSON.parse(optionsRaw);
                            if (!Array.isArray(optionsParsed)) throw new Error('not array');
                            optionsParsed.forEach((o, oi) => {
                                if (!o || o.value === undefined) throw new Error(`entry ${oi} missing name/value`);
                            });
                        } catch (e) {
                            addErr(rowNum, serial, refName, 'Options', `Options is not a valid JSON array of {name,value}: ${e.message}`);
                            optionsParsed = null;
                        }
                        // Name is optional (confirmed — not required in every
                        // case) — what actually matters is the Value column
                        // matching one of these entries' "value", since that's
                        // what actually gets selected.
                        if (optionsParsed && value) {
                            const knownValues = optionsParsed.map(o => o && o.value !== undefined ? String(o.value) : null).filter(v => v !== null);
                            if (knownValues.indexOf(value) === -1) {
                                addErr(rowNum, serial, refName, 'Value', `Value '${value}' doesn't match any Options entry's "value" (${knownValues.join(', ')}).`);
                            }
                        }
                    }
                } else if ((dType === 'range' || dType === 'interval' || (dType === 'advanced formula' && compositeType === 'range')) && optionsRaw) {
                    try {
                        optionsParsed = JSON.parse(optionsRaw);
                        if (!Array.isArray(optionsParsed)) throw new Error('not array');
                    } catch (e) {
                        addErr(rowNum, serial, refName, 'Options', `Recommends value is not a valid JSON array: ${e.message}`);
                        optionsParsed = null;
                    }
                }
            } else {
                // Asset Options data: "Select" needs a plain bare id in Options;
                // "Condition" needs a JSON {cases,defaultValue} block.
                const usesLink = dType === 'options' || (dType === 'advanced formula' && materialRange);
                if (usesLink) {
                    if (!optionsRaw) {
                        addErr(rowNum, serial, refName, 'Options', 'Options is required when Range Type is set.');
                    } else if (materialRange === 'condition') {
                        try {
                            optionsParsed = JSON.parse(optionsRaw);
                            if (!optionsParsed || !Array.isArray(optionsParsed.cases) || optionsParsed.defaultValue === undefined) {
                                throw new Error('expected {"cases":[...],"defaultValue":...}');
                            }
                            const blanks = findBlankConditionCases(optionsParsed);
                            if (blanks.length > 0) {
                                addErr(rowNum, serial, refName, 'Options', `Options has a blank value for ${blanks.join(', ')} — every case (and defaultValue) needs a real asset id or a '#'/'@' reference, not blank.`);
                            }
                        } catch (e) {
                            addErr(rowNum, serial, refName, 'Options', `Options must be a JSON {"cases":[...],"defaultValue":...} block for Range Type = Condition: ${e.message}`);
                            optionsParsed = null;
                        }
                    } else if (materialRange === 'select' && optionsRaw.trim().startsWith('{')) {
                        addErr(rowNum, serial, refName, 'Options', 'Options should be a single plain asset id for Range Type = Select, not JSON.');
                    }
                }
                // Asset Expression data: "Reference" is a plain string;
                // "Condition" needs a JSON {cases,defaultValue} block.
                if (expressionType === 'condition' && expressionRaw) {
                    try {
                        expressionParsed = JSON.parse(expressionRaw);
                        if (!expressionParsed || !Array.isArray(expressionParsed.cases) || expressionParsed.defaultValue === undefined) {
                            throw new Error('expected {"cases":[...],"defaultValue":...}');
                        }
                        const blanks = findBlankConditionCases(expressionParsed);
                        if (blanks.length > 0) {
                            addErr(rowNum, serial, refName, 'Expression', `Expression has a blank value for ${blanks.join(', ')} — every case (and defaultValue) needs a real asset id or a '#'/'@' reference, not blank.`);
                        }
                    } catch (e) {
                        addErr(rowNum, serial, refName, 'Expression', `Expression must be a JSON {"cases":[...],"defaultValue":...} block for Expression Type = Condition: ${e.message}`);
                        expressionParsed = null;
                    }
                }
            }

            if (!isAsset && expressionRaw && expressionRaw.trim().startsWith('{')) {
                try { JSON.parse(expressionRaw); } catch (e) { addErr(rowNum, serial, refName, 'Expression', 'Expression contains invalid JSON.'); }
            }
            const lockedCondition = cell(row, idx.lockedCondition);
            [['Hide condition', hideCondition], ['Minimum', min], ['Maximum', max], ['Locked condition', lockedCondition], ['Expression', !isAsset ? expressionRaw : (expressionType === 'reference' ? expressionRaw : '')]].forEach(([label, val]) => {
                if (val && !checkParens(val)) addErr(rowNum, serial, refName, label, 'Unbalanced parentheses.');
            });

            row.__optionsParsed = optionsParsed;
            row.__expressionParsed = expressionParsed;
        }
    }

    function buildDataMap(taskId, rows, idx, errorRows) {
        const map = new Map();
        lastDeleteSkippedProtected = [];
        deleteResetValues = new Map();
        deleteProtectedNamesPerModel = new Map();
        const partDynCols = taskId === 'PART_EDIT' ? dynamicPartColumns(rows, idx) : [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            if (errorRows && errorRows.has(rowNum)) continue;
            const serial = cell(row, idx.serial);
            if (!serial) continue;

            if (taskId === 'QUOTE') {
                const existing = map.get(serial) || {};
                const w = cell(row, idx.w), d = cell(row, idx.d), h = cell(row, idx.h);
                if (w) existing.w = w;
                if (d) existing.d = d;
                if (h) existing.h = h;
                map.set(serial, existing);
                continue;
            }

            if (!map.has(serial)) map.set(serial, []);

            if (taskId === 'PARAM_DEL') {
                const refName = cell(row, idx.paramName);
                const grouping = String(cell(row, idx.grouping) || '').toLowerCase().replace(/\s+/g, ' ').trim();
                // W/D/H/CZ are the model's own Basic/System parameters —
                // always structurally referenced (frameModels' own "size"
                // holds "#W"/"#D"/"#H", "materialBrandGoodId" holds "#CZ")
                // so a delete would never actually succeed. Per user
                // instruction, silently skip these rather than blocking
                // the whole batch — same treatment now extended to any row
                // whose Grouping column reads "System parameters" (when
                // that column is present), since the user confirmed the
                // whole group should be left alone the same way, not just
                // these four names. Every other (custom/local/global)
                // parameter in the same CSV still deletes normally and
                // still goes through the full dependency check.
                if (PROTECTED_PARAM_NAMES.has(refName) || grouping === 'system parameters') {
                    lastDeleteSkippedProtected.push(refName);
                    if (!deleteProtectedNamesPerModel.has(serial)) deleteProtectedNamesPerModel.set(serial, new Set());
                    deleteProtectedNamesPerModel.get(serial).add(refName);
                    // An explicit Value column always wins over any
                    // fetched/hardcoded default — captured here; the
                    // actual reset (explicit > live category default >
                    // hardcoded fallback) is resolved later in
                    // processModel, since fetching live defaults needs a
                    // network round-trip this synchronous pass can't make.
                    const explicitValue = idx.value !== -1 ? cell(row, idx.value) : '';
                    if (explicitValue !== '') {
                        if (!deleteResetValues.has(serial)) deleteResetValues.set(serial, new Map());
                        deleteResetValues.get(serial).set(refName, explicitValue);
                    }
                    continue;
                }
                map.get(serial).push({ refName });
                continue;
            }

            if (taskId === 'PART_DEL') {
                map.get(serial).push({
                    childSerial: cell(row, idx.childSerial),
                    partName: cell(row, idx.partName),
                    partRefName: cell(row, idx.partRefName)
                });
                continue;
            }

            if (taskId === 'PART_EDIT') {
                const customParamEntries = partDynCols
                    .map(({ header, index }) => ({ paramName: header, value: row[index] !== undefined ? row[index].trim() : '' }))
                    .filter(e => e.value !== '');
                map.get(serial).push({
                    childSerial: cell(row, idx.childSerial),
                    partName: cell(row, idx.partName),
                    partRefName: cell(row, idx.partRefName),
                    styleParameter: cell(row, idx.styleParameter),
                    width: cell(row, idx.w),
                    depth: cell(row, idx.d),
                    height: cell(row, idx.h),
                    positionX: cell(row, idx.positionX),
                    positionY: cell(row, idx.positionY),
                    positionZ: cell(row, idx.positionZ),
                    rotateX: cell(row, idx.rotateX),
                    rotateY: cell(row, idx.rotateY),
                    rotateZ: cell(row, idx.rotateZ),
                    positionMethod: cell(row, idx.positionMethod),
                    partHideCondition: cell(row, idx.partHideCondition),
                    partReplaceable: cell(row, idx.partReplaceable),
                    partQuotationRequired: cell(row, idx.partQuotationRequired),
                    partRemovable: cell(row, idx.partRemovable),
                    partComponentRemovable: cell(row, idx.partComponentRemovable),
                    partStylePack: cell(row, idx.partStylePack),
                    partBomOutput: cell(row, idx.partBomOutput),
                    partParameterEditable: cell(row, idx.partParameterEditable),
                    partIgnoreInternalInterference: cell(row, idx.partIgnoreInternalInterference),
                    partResetAfterSuppression: cell(row, idx.partResetAfterSuppression),
                    partSuppressCondition: cell(row, idx.partSuppressCondition),
                    customParameters: cell(row, idx.customParameters),
                    customParamEntries
                });
                continue;
            }

            if (taskId === 'DOOR_OPENING_EDIT') {
                map.get(serial).push({
                    name: cell(row, idx.doorOpeningName),
                    width: cell(row, idx.w),
                    height: cell(row, idx.h),
                    positionX: cell(row, idx.positionX),
                    positionY: cell(row, idx.positionY),
                    positionZ: cell(row, idx.positionZ),
                    rotateX: cell(row, idx.rotateX),
                    rotateY: cell(row, idx.rotateY),
                    rotateZ: cell(row, idx.rotateZ),
                    hideCondition: cell(row, idx.partHideCondition),
                    positionMethod: cell(row, idx.positionMethod),
                    doorOpeningType: cell(row, idx.doorOpeningType),
                    adaptationUnit: cell(row, idx.doorOpeningAdaptationUnit)
                });
                continue;
            }

            const paramCategory = cell(row, idx.paramCategory);
            const globalId = cell(row, idx.globalId);
            map.get(serial).push({
                refName: cell(row, idx.paramName),
                displayName: cell(row, idx.displayName),
                grouping: cell(row, idx.grouping),
                category: paramCategory, globalId,
                isGlobalRow: paramCategory.toLowerCase() === 'global' || !!globalId,
                parameterType: cell(row, idx.paramType).toLowerCase(),
                dataType: cell(row, idx.dataType).toLowerCase(),
                value: cell(row, idx.value),
                min: cell(row, idx.min),
                max: cell(row, idx.max),
                step: cell(row, idx.step),
                compositeType: cell(row, idx.compositeType).toLowerCase(),
                valueRelationship: cell(row, idx.valueRelationship).toLowerCase(),
                defaultState: cell(row, idx.defaultState).toLowerCase(),
                materialRange: cell(row, idx.materialRange).toLowerCase(),
                expressionType: cell(row, idx.expressionType).toLowerCase(),
                hideCondition: cell(row, idx.hideCondition),
                lockedCondition: cell(row, idx.lockedCondition),
                imosOutputCondition: cell(row, idx.imosOutputCondition),
                optionsRaw: cell(row, idx.options),
                expressionRaw: cell(row, idx.expression),
                optionsParsed: row.__optionsParsed || null,
                expressionParsed: row.__expressionParsed || null
            });
        }
        return map;
    }

    // =========================================================================
    // SECTION 5: PARAMETER-TYPE ID / GROUPING RESOLUTION
    // =========================================================================
    // Advanced Formula uses TWO distinct paramTypeIds depending on Composite
    // type: "Range" composite -> 4, "Options" composite -> 7. Verified against
    // real editorData samples — the old script always used 4, which is wrong
    // for the Options-composite case.
    function computeParamTypeId(dataType, compositeType) {
        switch (dataType) {
            case 'unlimited': return 0;
            case 'range': return 1;
            case 'options': return 2;
            case 'interval': return 3;
            case 'formula': return 5;
            case 'fixed value': return 6;
            case 'advanced formula': return compositeType === 'options' ? 7 : 4;
            default: return 0;
        }
    }

    // Present even in a bare/default model with an empty paramNames array —
    // never auto-delete this one just because it has 0 members.
    function isSystemDefaultGroup(name) {
        return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim() === 'custom parameters';
    }

    // "System parameters" / "Basic parameters" are native, structural
    // sections of Kujiale's own panel — not something reachable through
    // customParamGroups[] at all (confirmed against a real editorData
    // sample). A row lands there on its own once it isn't claimed by a real
    // custom group; applyGrouping must never create a same-named entry for
    // either, or it shows up as a duplicate empty-looking folder.
    function isNativeGroupSection(name) {
        const n = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return n === 'system parameters' || n === 'basic parameters';
    }

    // Removes refName from whichever group(s) currently list it, then drops
    // any group left with 0 members (except the system default) — an empty
    // group otherwise lingers in customParamGroups[] forever, which is why
    // deleted parameters' group folders stayed visible (just empty) in the UI.
    function removeFromAllGroups(ed, refName) {
        if (!ed.customParamGroups) return;
        ed.customParamGroups.forEach(g => {
            const i = (g.paramNames || []).indexOf(refName);
            if (i !== -1) g.paramNames.splice(i, 1);
        });
        ed.customParamGroups = ed.customParamGroups.filter(g => g.paramNames.length > 0 || isSystemDefaultGroup(g.groupName));
    }

    // "Grouping" maps to the top-level editorData.customParamGroups[] array,
    // not to input.groupTypeId — confirmed from a real editorData sample.
    function applyGrouping(ed, refName, groupName) {
        if (!groupName) return;
        if (!ed.customParamGroups) ed.customParamGroups = [];
        removeFromAllGroups(ed, refName);
        if (isNativeGroupSection(groupName)) return;
        let target = ed.customParamGroups.find(g => g.groupName === groupName);
        if (!target) {
            // Creating a brand new group: if the empty system-default group
            // is still sitting unclaimed, repurpose it (rename in place)
            // instead of leaving it empty alongside a separate new group.
            // Only the first new group gets to claim it — once renamed it's
            // no longer "Custom parameters", so later new groups create
            // fresh entries as normal.
            const emptyDefault = ed.customParamGroups.find(g => isSystemDefaultGroup(g.groupName) && g.paramNames.length === 0);
            if (emptyDefault) {
                emptyDefault.groupName = groupName;
                target = emptyDefault;
            } else {
                target = { groupName, paramNames: [] };
                ed.customParamGroups.push(target);
            }
        }
        if (!target.paramNames.includes(refName)) target.paramNames.push(refName);
    }

    // Only used for non-asset Options/Range-family parameters (editorOptions /
    // editorRecommends) — asset types route their "Options" data through
    // `link` instead (see buildAssetConditionJson).
    //
    // "name" is the label Kujiale's Value selector displays for the
    // currently-picked option; the Optional* list itself falls back to
    // showing "value" when name is blank, but the Value* selector does not
    // — confirmed twice (VT, PFT) with a blank "name" in the CSV: the
    // Optional* list showed the values fine, but Value* stayed empty even
    // though the underlying value was saved correctly. When entering an
    // option manually in Kujiale's own UI with no name, Kujiale silently
    // defaults the label to the value — so we do the same here rather than
    // sending a literal empty name (which the API takes at face value).
    function buildOptionEntries(parsedArr) {
        return parsedArr.map(o => ({
            name: (o.name !== undefined && o.name !== null && String(o.name).trim() !== '')
                ? String(o.name)
                : (o.value != null ? String(o.value) : ''),
            value: o.value != null ? String(o.value) : '',
            ignore: (o.ignore !== undefined && o.ignore !== null && o.ignore !== '') ? Utils.normalizeExpr(String(o.ignore)) : (o.ignore === '' ? '' : null),
            priority: o.priority != null ? o.priority : '',
            extAttr: o.extAttr || {}
        }));
    }

    // Asset "Range Type = Condition" data (the `link` field): case/default
    // values are always bare asset ids, never wrapped — confirmed on both
    // Material_Options_Condition and Style_Options_Condition.
    function buildAssetConditionJson(parsed) {
        if (!parsed) return '';
        const obj = _.cloneDeep(parsed);
        if (Array.isArray(obj.cases)) {
            obj.cases.forEach(c => { if (c.condition) c.condition = Utils.normalizeExpr(c.condition); });
        }
        return JSON.stringify(obj);
    }

    // Asset "Expression Type = Condition" data (the `formula` field): literal
    // (non-#Reference) case/default values get wrapped per Utils.wrapAssetValue
    // — bare for Material/Contour, {obsBrandGoodId,versionId} JSON for Style.
    function buildAssetFormulaConditionJson(parsed, pType) {
        if (!parsed) return '';
        const obj = _.cloneDeep(parsed);
        if (Array.isArray(obj.cases)) {
            obj.cases.forEach(c => {
                if (c.condition) c.condition = Utils.normalizeExpr(c.condition);
                if (c.value !== undefined) c.value = Utils.wrapAssetValue(c.value, pType);
            });
        }
        if (obj.defaultValue !== undefined) obj.defaultValue = Utils.wrapAssetValue(obj.defaultValue, pType);
        return JSON.stringify(obj);
    }

    // IMOS Output Condition -> editorData.outputConfig.productionParams[],
    // keyed by paramName. Confirmed shape: { formulaOutput, paramName,
    // outputName, value, output }. formulaOutput carries the CSV's
    // true/false/condition string; outputName/value have no CSV column yet
    // (no confirmed sample showing what drives them) and are left at their
    // defaults on a newly-created entry.
    function applyImosOutput(ed, paramName, conditionStr) {
        if (!conditionStr) return;
        if (!ed.outputConfig) ed.outputConfig = {};
        if (!ed.outputConfig.productionParams) ed.outputConfig.productionParams = [];
        let entry = ed.outputConfig.productionParams.find(p => p.paramName === paramName);
        if (!entry) {
            entry = { formulaOutput: '', paramName, outputName: '', value: '', output: true };
            ed.outputConfig.productionParams.push(entry);
        }
        entry.formulaOutput = Utils.normalizeExpr(conditionStr);
        entry.output = true;
    }

    function newInputSkeleton(refName, displayName) {
        return {
            id: String(Date.now()) + Math.floor(Math.random() * 10000),
            paramName: refName, value: '', valueType: 'float', description: null,
            valueFormat: 0, extVariableAttr: {}, preCalcModelRefNames: null,
            displayName: displayName || refName, globalId: null, paramTypeId: 0,
            max: '', min: '', step: '', link: null, linkForm: 0, formula: null,
            formulaForm: 0, formulaDisplayName: null, scriptName: null, status: -1,
            ignore: null, required: false, visible: true, valueDisplayNames: [],
            editorOptions: [], editorRecommends: [], groupTypeId: 0, valueRequired: true,
            extAttr: {}, originalValue: null, typeId: 0, generated: false
        };
    }

    // The library a model's "Import Global Parameter" dialog searches is the
    // page's own `extendlibraryid` query param — same id the dialog's own
    // globalinput/new request used, confirmed by network capture.
    function currentLibraryId() {
        return new URLSearchParams(window.location.search).get('extendlibraryid') || '';
    }

    // The page's own `libid` query param — confirmed as the
    // "customLibraryId" the template/new endpoint expects, by network
    // capture of the "create new model" flow.
    function currentCustomLibraryId() {
        return new URLSearchParams(window.location.search).get('libid') || '';
    }

    // Live, read-only source for a system parameter's real default value —
    // GET .../editordata/template/new?prodcatid=...&obsLibraryId=...&
    // customLibraryId=..., the same endpoint Kujiale's own editor calls
    // when spinning up a brand-new model of a category, confirmed by
    // network capture. Unlike actually creating a new model, this one
    // comes back with an empty paramModelInfo and no "model" block — it's
    // a pure template lookup with no side effects. Cached per prodCatId
    // (as a Promise, so concurrent callers share one in-flight fetch)
    // since the defaults don't change between models of the same category
    // within a single run.
    async function fetchCategoryDefaults(prodCatId) {
        if (categoryDefaultsCache.has(prodCatId)) return categoryDefaultsCache.get(prodCatId);
        const promise = (async () => {
            const origin = window.location.origin;
            const obsLibraryId = currentLibraryId();
            const customLibraryId = currentCustomLibraryId();
            const url = `${origin}/editor/api/site/editordata/template/new?prodcatid=${encodeURIComponent(prodCatId)}&obsLibraryId=${encodeURIComponent(obsLibraryId)}&customLibraryId=${encodeURIComponent(customLibraryId)}`;
            const resp = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                mode: 'cors',
                headers: { accept: '*/*', 'editor-locale': 'en_IN', 'x-qh-locale': 'en_IN', 'x-qh-site': 'coohom' }
            });
            if (!resp.ok) throw new Error(`template/new lookup failed, status ${resp.status}`);
            const json = await resp.json();
            const inputs = (json.editorData && json.editorData.inputs) || [];
            // Store the whole template entry, not just its value — W/D/H/CZ
            // need a full structural reset (see the PARAM_DEL reset logic),
            // since their shape (paramTypeId/formula) can legitimately
            // differ between a fresh template and a customized live model.
            const map = new Map();
            inputs.forEach(inp => { if (inp.paramName) map.set(inp.paramName, inp); });
            return map;
        })();
        categoryDefaultsCache.set(prodCatId, promise);
        return promise;
    }

    // Fetches a global parameter's full definition from the same endpoint
    // the "Import Global Parameter" dialog uses (GET .../globalinput/new).
    // That response — not a bare globalId — is what actually carries
    // valueType/paramTypeId/editorOptions/min/max/step/link/ignore; those
    // are NOT reconstructable from the CSV and must come from this lookup.
    // Captured verbatim via DevTools "Copy as fetch" from a real, successful
    // "Import Global Parameter" dialog request — this is a POST with an
    // empty-array body (presumably a tag-filter list; [] = unfiltered), NOT
    // a GET as every earlier attempt here assumed. That mismatch is exactly
    // why it 404'd at the gateway: a GET against a POST-only route. The
    // content-type/x-qh-* headers below are likewise required, not optional.
    async function fetchGlobalParamDef(paramName, obsLibraryId) {
        const origin = window.location.origin;
        const pageSize = 10;
        let start = 0;
        let totalCount = Infinity;
        while (start < totalCount) {
            const url = `${origin}/editor/api/site/globalinput/new?start=${start}&num=${pageSize}&query=&excludevaluetypes=&obsLibraryId=${encodeURIComponent(obsLibraryId)}`;
            const resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                mode: 'cors',
                headers: {
                    accept: '*/*',
                    'content-type': 'application/json;charset=UTF-8',
                    'editor-locale': 'en_US',
                    'x-qh-locale': 'en_US',
                    'x-qh-site': 'coohom'
                },
                body: '[]'
            });
            if (!resp.ok) throw new Error(`globalinput lookup failed, status ${resp.status} (url: ${url})`);
            const json = await resp.json();
            const d = json.d || {};
            const list = d.inputs || [];
            const match = list.find(x => x.paramName === paramName);
            if (match) return match;
            totalCount = d.totalCount != null ? d.totalCount : list.length;
            if (list.length === 0) break;
            start += pageSize;
        }
        return null;
    }

    // Returns an error string on failure, or undefined on success — the
    // async global-parameter lookup means this can genuinely fail (network,
    // not-found), unlike the rest of this function's pure CSV compilation.
    async function compileParamEditRow(ed, row) {
        if (!ed.inputs) ed.inputs = [];
        let input = ed.inputs.find(i => i.paramName === row.refName);
        if (!input) { input = newInputSkeleton(row.refName, row.displayName); ed.inputs.push(input); }

        // A row being compiled here always carries a real, user-authored
        // definition — even when `input` started life as a bare
        // selfHealReferencedVars() placeholder (generated:true). Every
        // confirmed real sample (native-UI-created, round-tripped through
        // Kujiale successfully) shows generated:false; leaving a stale
        // generated:true on a promoted stub sends the server a fully-formed
        // complex definition still flagged as an internal auto-placeholder.
        input.generated = false;

        if (row.isGlobalRow) {
            const libId = currentLibraryId();
            if (!libId) return `Cannot resolve Global parameter '${row.refName}' — this page's URL has no extendlibraryid.`;
            let def;
            try {
                def = await fetchGlobalParamDef(row.refName, libId);
            } catch (e) {
                return `Global parameter lookup failed for '${row.refName}': ${e.message}`;
            }
            if (!def) return `Global parameter '${row.refName}' not found in this model's library (searched extendlibraryid=${libId}).`;

            input.globalId = def.globalId != null ? def.globalId : input.globalId;
            input.displayName = def.displayName || input.displayName;
            input.valueType = def.valueType || input.valueType;
            input.paramTypeId = def.paramTypeId != null ? def.paramTypeId : input.paramTypeId;
            input.editorOptions = def.editorOptions || [];
            input.editorRecommends = def.editorRecommends || [];
            input.min = def.min != null ? def.min : input.min;
            input.max = def.max != null ? def.max : input.max;
            input.step = def.step != null ? def.step : input.step;
            input.link = def.link || input.link;
            input.value = def.value != null ? def.value : input.value;
            if (def.ignore !== undefined) input.ignore = def.ignore;

            // CSV values, when supplied, override the catalog defaults.
            // globalId is NOT overridable here on purpose — it's resolved
            // authoritatively from the live lookup by Parameter Name, and a
            // stale/wrong CSV value could silently point it at the wrong
            // global parameter. Parameter Name is the only identifier that
            // matters; the Global Parameter ID column is no longer read.
            if (row.displayName) input.displayName = row.displayName;
            if (row.value !== '') input.value = row.value;
            if (row.hideCondition) input.ignore = Utils.normalizeExpr(row.hideCondition);
            if (row.lockedCondition) {
                if (!input.extAttr) input.extAttr = {};
                input.extAttr['diy-immutable'] = { value: Utils.normalizeExpr(row.lockedCondition), displayName: null, valueType: 'boolean' };
            }

            applyGrouping(ed, row.refName, row.grouping);
            applyImosOutput(ed, row.refName, row.imosOutputCondition);
            return;
        }

        const pType = row.parameterType;
        const dType = row.dataType;
        const isAsset = ASSET_TYPES.includes(pType);

        if (row.displayName) input.displayName = row.displayName;

        if (pType === 'integer' || pType === 'int') input.valueType = 'int';
        else if (pType === 'text' || pType === 'string') input.valueType = 'string';
        else if (pType === 'boolean') input.valueType = 'boolean';
        else if (pType === 'multiple boolean values' || pType === 'booleanlist') input.valueType = 'booleanlist';
        else if (pType === 'float2') input.valueType = 'float2';
        else if (isAsset) input.valueType = pType;
        else input.valueType = 'float';

        // Every confirmed booleanlist sample (Unlimited and Fixed Value
        // alike) carries valueDisplayNames:["0","1"] — the server rejects a
        // booleanlist input missing these labels ("参数值错误" with no other
        // detail). No CSV column drives this; it's a structural requirement
        // of the valueType itself.
        if (input.valueType === 'booleanlist' && (!input.valueDisplayNames || input.valueDisplayNames.length === 0)) {
            input.valueDisplayNames = ['0', '1'];
        }

        // Material/Style/Contour Advanced Formula has no Composite type
        // choice — it's always internal paramTypeId 4 (confirmed on all 8
        // Material_AdvancedFormula_* and Style_AdvancedFormula_* samples).
        const paramTypeId = isAsset
            ? computeParamTypeId(dType, 'range')
            : computeParamTypeId(dType, row.compositeType);
        input.paramTypeId = paramTypeId;

        if (row.value !== '') {
            if (isAsset) input.value = Utils.wrapAssetValue(row.value, pType);
            else if (pType === 'float2') input.value = Utils.formatFloat2(row.value);
            else input.value = row.value;
        }

        if (isAsset) {
            input.min = ''; input.max = ''; input.step = '';
        } else {
            if (row.min !== '') input.min = Utils.normalizeExpr(row.min);
            if (row.max !== '') input.max = Utils.normalizeExpr(row.max);
            if (row.step !== '') input.step = row.step;
        }

        if (isAsset) {
            // "Options" column drives `link` for Options data type or an
            // Advanced Formula row with Range Type set — never
            // editorOptions (that array stays empty for asset types).
            const usesLink = dType === 'options' || (dType === 'advanced formula' && row.materialRange);
            if (usesLink && row.optionsRaw !== '') {
                if (row.materialRange === 'condition') {
                    input.link = buildAssetConditionJson(row.optionsParsed);
                    input.linkForm = 1;
                } else {
                    input.link = Utils.wrapAssetLink(row.optionsRaw);
                    input.linkForm = 0;
                }
            }
            // "Expression" column drives `formula` for Formula data type or
            // an Advanced Formula row with Expression Type set.
            const usesFormula = dType === 'formula' || (dType === 'advanced formula' && row.expressionType);
            if (usesFormula && row.expressionRaw !== '') {
                if (row.expressionType === 'condition') {
                    input.formula = buildAssetFormulaConditionJson(row.expressionParsed, pType);
                    input.formulaForm = 1;
                    // When Default state = Formula, a real successfully-saved
                    // sample shows `value` mirrors the formula's own
                    // defaultValue — not the Value column, which belongs to
                    // the link/Select side and can reference a completely
                    // different asset than the formula's cases. Sending the
                    // link-side asset while status:1 tells the server "trust
                    // the formula" is a real mismatch, not just cosmetic.
                    if (row.defaultState === 'formula' && row.expressionParsed && row.expressionParsed.defaultValue !== undefined) {
                        input.value = Utils.wrapAssetValue(row.expressionParsed.defaultValue, pType);
                    }
                } else {
                    input.formula = Utils.normalizeExpr(row.expressionRaw);
                    input.formulaForm = 0;
                }
                input.formulaDisplayName = input.displayName;
            }
            if (dType === 'advanced formula') {
                input.status = row.defaultState === 'formula' ? 1 : 0;
                if (!input.extAttr) input.extAttr = {};
                // Value relationships (Outside/Within) does not apply to
                // asset types — formulaLimit is always "0" on every
                // Material/Style Advanced Formula sample seen.
                input.extAttr.formulaLimit = { value: '0', displayName: null, valueType: null };
            } else {
                // status:1/formulaLimit are an Advanced-Formula-only concept.
                // An existing input may still carry a stale status:1 from a
                // prior edit (compileParamEditRow only sets status via
                // newInputSkeleton for brand-new inputs) — force it back to
                // -1 here so plain Formula/Options rows can never inherit it.
                input.status = -1;
                if (input.extAttr) delete input.extAttr.formulaLimit;
                if (dType !== 'formula' && dType !== 'options') {
                    input.link = null; input.linkForm = 0; input.formula = null; input.formulaForm = 0;
                }
            }
        } else {
            const isOptionsFamily = paramTypeId === 2 || paramTypeId === 7;
            const isRangeFamily = paramTypeId === 1 || paramTypeId === 3 || paramTypeId === 4;
            if (row.optionsParsed) {
                const entries = buildOptionEntries(row.optionsParsed);
                if (isOptionsFamily) { input.editorOptions = entries; input.editorRecommends = []; }
                else if (isRangeFamily) { input.editorRecommends = entries; input.editorOptions = []; }
            }

            if (paramTypeId === 4 || paramTypeId === 5 || paramTypeId === 7) {
                if (row.expressionRaw !== '') {
                    input.formula = Utils.normalizeExpression(row.expressionRaw);
                    input.formulaForm = String(input.formula).trim().startsWith('{') ? 1 : 0;
                    input.formulaDisplayName = input.displayName;
                }
                if (paramTypeId === 4 || paramTypeId === 7) {
                    input.status = row.defaultState === 'formula' ? 1 : 0;
                    if (!input.extAttr) input.extAttr = {};
                    input.extAttr.formulaLimit = { value: row.valueRelationship === 'within' ? '1' : '0', displayName: null, valueType: null };
                }
            } else {
                input.formula = null; input.formulaForm = 0; input.link = null; input.linkForm = 0;
                if (input.extAttr) delete input.extAttr.formulaLimit;
            }
        }

        if (row.hideCondition !== '') input.ignore = Utils.normalizeExpr(row.hideCondition);

        // Locked condition -> extAttr['diy-immutable'] (confirmed from a
        // real editorData sample: a locked Height had
        // extAttr.diy-immutable = {value: "#W < 100 ? TRUE : FALSE",
        // displayName: null, valueType: "boolean"}; an unlocked Depth had
        // extAttr: {} — no key at all). This column was previously read for
        // validation only and never actually written anywhere.
        if (row.lockedCondition !== '') {
            if (!input.extAttr) input.extAttr = {};
            input.extAttr['diy-immutable'] = { value: Utils.normalizeExpr(row.lockedCondition), displayName: null, valueType: 'boolean' };
        } else if (input.extAttr) {
            delete input.extAttr['diy-immutable'];
        }

        applyGrouping(ed, row.refName, row.grouping);
        applyImosOutput(ed, row.refName, row.imosOutputCondition);
    }

    // =========================================================================
    // SECTION 5b2: PARAMETER EXTRACTION (editorData -> Parameter Add sheet)
    // =========================================================================
    // The reverse of compileParamEditRow: given a live model's editorData,
    // produce rows in the exact column shape the Parameter Add sheet expects,
    // so an existing model's current parameters can be pulled down and fed
    // straight back in as a batch-edit CSV.
    const PARAM_EXPORT_HEADERS = [
        'Product Name', 'Product serial number', 'Parameter Category', 'Grouping',
        'Parameter type', 'Data type', 'Display Name', 'Parameter Name', 'Value',
        'Minimum', 'Maximum', 'Step size', 'Options', 'Expression', 'Hide condition',
        'Locked condition', 'IMOS Output Condition', 'Default state', 'Composite type',
        'Value relationships', 'Range Type', 'Expression Type'
    ];
    const DTYPE_BY_PARAM_TYPE_ID = { 0: 'Unlimited', 1: 'Range', 2: 'Options', 3: 'Interval', 4: 'Advanced Formula', 5: 'Formula', 6: 'Fixed Value', 7: 'Advanced Formula' };
    const PTYPE_BY_VALUE_TYPE = { int: 'Integer', string: 'Text', boolean: 'Boolean', booleanlist: 'Multiple Boolean Values', float2: 'Float2', float: 'Float' };

    // A model's saved asset case values are the WRAPPED form (bare id for
    // Material/Contour, {obsBrandGoodId,versionId} JSON for Style — see
    // Utils.wrapAssetValue) — unwrap back to a bare id so the exported sheet
    // matches the convention the Parameter Add sheet's own columns already
    // use (confirmed against a real sample: bare ids in every case, never
    // JSON) and so a re-import doesn't have to special-case already-wrapped
    // input.
    // Style values are stored as {"obsBrandGoodId":...,"versionId":...} —
    // the versionId is REAL and load-bearing (confirmed the hard way: a
    // real re-import round-tripped several Style params — SH1/SH2's
    // FGPS/GPS/HNS, SKC's SKF/LEGS — through an earlier version of this
    // function that collapsed the value down to just the bare id, and
    // Utils.wrapAssetValue's own bare-id path always defaults versionId to
    // 0 on the way back in; that silently downgraded every one of those
    // parts' actual versionId (4, 2, 3, 5, 25, ...) to 0 even though the
    // user never touched those cells, and was the real cause of a
    // "Server validation failed: 属性错误" rejection). Kept as the full
    // JSON instead — Utils.wrapAssetValue already passes a JSON value
    // through unchanged on import, so an untouched cell round-trips
    // exactly; a user who deliberately types a bare id still gets that
    // sensible versionId:0 default for a genuinely NEW value.
    function unwrapAssetVal(v) {
        if (v === null || v === undefined || v === '') return '';
        const s = String(v).trim();
        if (s.startsWith('#') || s.startsWith('@')) return s;
        if (s.startsWith('{')) {
            try { const o = JSON.parse(s); if (o && o.obsBrandGoodId) return s; } catch (e) { /* not JSON after all — fall through */ }
        }
        return s;
    }
    function unwrapConditionCaseValues(raw) {
        if (!raw) return '';
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { return raw; }
        if (Array.isArray(obj.cases)) obj.cases.forEach(c => { if (c.value !== undefined) c.value = unwrapAssetVal(c.value); });
        if (obj.defaultValue !== undefined) obj.defaultValue = unwrapAssetVal(obj.defaultValue);
        return JSON.stringify(obj);
    }
    function float2ValueToPair(v) {
        if (v === null || v === undefined || v === '') return '';
        try { const o = JSON.parse(v); return `${o.x},${o.y}`; } catch (e) { return v; }
    }

    function extractParamsFromEditorData(ed, modelId) {
        const groupOf = (paramName) => {
            const g = (ed.customParamGroups || []).find(g => (g.paramNames || []).includes(paramName));
            return g ? g.groupName : '';
        };
        const imosOf = (paramName) => {
            const p = ((ed.outputConfig && ed.outputConfig.productionParams) || []).find(p => p.paramName === paramName);
            return (p && p.output && p.formulaOutput) ? p.formulaOutput : '';
        };

        return (ed.inputs || [])
            // selfHealReferencedVars() placeholder stubs aren't real
            // authored parameters — leave them out of the exported sheet.
            .filter(input => !input.generated)
            .map(input => {
                const isAsset = ASSET_TYPES.includes(input.valueType);
                const paramTypeId = input.paramTypeId;
                const isAdvFormula = paramTypeId === 4 || paramTypeId === 7;
                const row = {
                    productName: '',
                    serial: modelId,
                    paramCategory: input.globalId ? 'Global' : 'Local',
                    grouping: groupOf(input.paramName),
                    paramType: isAsset ? (input.valueType.charAt(0).toUpperCase() + input.valueType.slice(1)) : (PTYPE_BY_VALUE_TYPE[input.valueType] || 'Float'),
                    dataType: DTYPE_BY_PARAM_TYPE_ID[paramTypeId] || 'Unlimited',
                    displayName: input.displayName || '',
                    paramName: input.paramName,
                    value: isAsset ? unwrapAssetVal(input.value) : (input.valueType === 'float2' ? float2ValueToPair(input.value) : (input.value != null ? input.value : '')),
                    min: isAsset ? '' : (input.min != null ? input.min : ''),
                    max: isAsset ? '' : (input.max != null ? input.max : ''),
                    step: isAsset ? '' : (input.step != null ? input.step : ''),
                    options: '',
                    expression: '',
                    hideCondition: input.ignore != null ? input.ignore : '',
                    lockedCondition: (input.extAttr && input.extAttr['diy-immutable'] && input.extAttr['diy-immutable'].value) || '',
                    imosOutputCondition: imosOf(input.paramName),
                    defaultState: isAdvFormula ? (input.status === 1 ? 'Formula' : 'Value') : '',
                    compositeType: (!isAsset && isAdvFormula) ? (paramTypeId === 7 ? 'Options' : 'Range') : '',
                    valueRelationship: '',
                    materialRange: '',
                    expressionType: ''
                };

                if (isAsset) {
                    if (input.link) {
                        row.materialRange = input.linkForm === 1 ? 'Condition' : 'Select';
                        row.options = input.linkForm === 1 ? unwrapConditionCaseValues(input.link) : input.link;
                    }
                    if (input.formula) {
                        row.expressionType = input.formulaForm === 1 ? 'Condition' : 'Reference';
                        row.expression = input.formulaForm === 1 ? unwrapConditionCaseValues(input.formula) : input.formula;
                    }
                } else {
                    if (paramTypeId === 2 && Array.isArray(input.editorOptions) && input.editorOptions.length) {
                        row.options = JSON.stringify(input.editorOptions.map(o => ({ name: o.name, value: o.value, ignore: o.ignore != null ? o.ignore : '' })));
                    } else if ((paramTypeId === 1 || paramTypeId === 3 || paramTypeId === 4) && Array.isArray(input.editorRecommends) && input.editorRecommends.length) {
                        row.options = JSON.stringify(input.editorRecommends.map(o => ({ name: o.name, value: o.value, ignore: o.ignore != null ? o.ignore : '' })));
                    }
                    if ((isAdvFormula || paramTypeId === 5) && input.formula) {
                        row.expression = input.formula;
                    }
                    if (isAdvFormula) {
                        const fl = input.extAttr && input.extAttr.formulaLimit;
                        row.valueRelationship = (fl && String(fl.value) === '1') ? 'Within' : 'Outside';
                    }
                }
                return row;
            });
    }

    // =========================================================================
    // SECTION 5b3: PART EXTRACTION (editorData -> Part Edit sheet)
    // =========================================================================
    // Reverse of compilePartEditRow: given a live model's editorData, produce
    // rows in the exact column shape the Part Edit sheet expects, so an
    // existing model's parts can be reviewed/bulk-edited as a CSV. Matches
    // compilePartEditRow's own field mapping one-for-one (W/D/H, position,
    // rotationDegree, invokedPosType, the Design Attribute flags, modelPackage,
    // and everything else as a Custom Parameters entry).
    // Style Parameter is intentionally left out here — it's an
    // instance-delegation flag (functionName), not a part parameter, and
    // per user request isn't part of this sheet. Custom Parameters is also
    // left out of this fixed list: each custom parameter gets its own
    // dynamic column instead (header = simpleName or paramName, e.g.
    // "CB"/"CZ") — see the partsBtn handler in openExtractor, which appends
    // those columns after this fixed set.
    const PART_EXPORT_HEADERS = [
        'Product serial number', 'Child Serial Number', 'Part Name', 'Reference name',
        'Width', 'Depth', 'Height',
        'Position X', 'Position Y', 'Position Z', 'Rotate X', 'Rotate Y', 'Rotate Z',
        'Position Method', 'Hide Conditions', 'Replaceable', 'Quotation Required',
        'Removable', 'Component Removable', 'Style Pack', 'BOM Output',
        'Parameter Editable', 'Ignore Internal Interference',
        'Reset the part after the suppression is released', 'Suppress condition'
    ];

    // Every part-level paramName that already has its own dedicated column
    // above — anything else on the part is exported as a Custom Parameters
    // entry instead. instanceOverride/invokedPos/offset are internal/
    // structural fields, not meaningful to round-trip generically, so they're
    // left out rather than cluttering every row with them.
    const PART_RESERVED_PARAM_NAMES = new Set([
        'W', 'D', 'H', 'position', 'rotationDegree', 'invokedPosType', 'ignore',
        'replaceable', 'needQuotation', 'isDeletable', 'cascadeDelete', 'modelPackage',
        'displayInCostList', 'paramOverride', 'ignoreInnerIntersect', 'resetWhenSuppress',
        'KJL_model_suppress_param', 'instanceOverride', 'invokedPos', 'offset',
        // Internal rule-reference field (holds JSON like {"ruleId":"..."})
        // rather than an editable value — not useful as a CSV column, left
        // out per user request.
        'fit'
    ]);

    function findPartParam(instance, paramName) {
        return (instance.parameters || []).find(p => p.paramName === paramName);
    }

    // Any group name containing "Link Parameters" (Link Parameters, IMOS
    // System Link Parameters, Link Parameters J Gola/C Gola/Finger Groove/
    // Skirting, ...) is pulled to the front of the Custom Parameters
    // columns on export, right after Suppress condition, per user request.
    const LINK_GROUP_NAME_RE = /link parameters?/i;

    function decodeFloat3(raw) {
        if (!raw) return { x: '', y: '', z: '' };
        try {
            const o = JSON.parse(raw);
            return { x: o.x != null ? o.x : '', y: o.y != null ? o.y : '', z: o.z != null ? o.z : '' };
        } catch (e) {
            return { x: '', y: '', z: '' };
        }
    }

    // Mirrors compilePartEditRow's own 3-way Custom Parameters dispatch
    // (#-reference / Condition-JSON / direct) in reverse, so a re-imported
    // value round-trips to the same asset-wrapped shape it started as.
    function decodePartCustomParamValue(p) {
        if (p.value === undefined || p.value === null || p.value === '') return undefined;
        if (['material', 'style', 'contour'].includes(p.valueType)) {
            const v = String(p.value).trim();
            if (v.startsWith('#')) return v;
            if (p.formulaForm === 1 && v.startsWith('{')) return unwrapConditionCaseValues(v);
            return unwrapAssetVal(v);
        }
        return p.value;
    }

    function extractPartsFromEditorData(ed, modelId) {
        // Group membership is genuinely per-PART, not just per-model — a
        // real sample shows the SAME key (e.g. "GOL") filed under "Light"
        // in the model-wide ed.customParamGroups but under a part's OWN
        // "Link Parameters" group in that part's own customParamGroups[],
        // and different parts can even give the same key different group
        // names (BTS's own "Link Parameters" includes "BCS", SPL's own
        // "Link Parameters" doesn't). So every key's group set is built
        // from BOTH sources and can legitimately hold more than one name.
        const modelGroupNamesByKey = {};
        (ed.customParamGroups || []).forEach(g => {
            (g.paramNames || []).forEach(name => {
                if (!modelGroupNamesByKey[name]) modelGroupNamesByKey[name] = new Set();
                modelGroupNamesByKey[name].add(g.groupName);
            });
        });
        const groupsForKey = (instance, key) => {
            const set = new Set(modelGroupNamesByKey[key] || []);
            (instance.customParamGroups || []).forEach(g => {
                if ((g.paramNames || []).includes(key)) set.add(g.groupName);
            });
            return [...set];
        };

        return (ed.modelInstances || []).map(instance => {
            const posP = findPartParam(instance, 'position');
            const rotP = findPartParam(instance, 'rotationDegree');
            const pos = decodeFloat3(posP && posP.value);
            const rot = decodeFloat3(rotP && rotP.value);
            const dim = (name) => {
                const p = findPartParam(instance, name);
                return (p && p.paramTypeId !== 5 && p.value != null) ? p.value : '';
            };
            const flag = (name) => {
                const p = findPartParam(instance, name);
                return (p && p.value != null) ? p.value : '';
            };
            const modelPackageP = findPartParam(instance, 'modelPackage');

            // Wide format: one key per custom parameter, keyed by the same
            // friendlier alias the model editor itself shows (simpleName,
            // e.g. "CZ" for materialBrandGoodId) when the part has one,
            // falling back to the raw internal paramName (e.g. "CB")
            // otherwise — matches compilePartEditRow's lookup exactly, so
            // download and upload use the same column names.
            const customParams = {};
            // The keyword alone (e.g. "CZ") is hard to identify — this
            // carries each key's own displayName (e.g. "Material") so the
            // partsBtn handler can build a "DisplayName\nCODE" column
            // header. Values only, not part of what's uploaded back.
            const customParamDisplayNames = {};
            // Same idea, one level up — each key's own Group Name(s) (e.g.
            // ["Light","Link Parameters"] — see groupsForKey above for why
            // a key can have more than one), for the Group Name header row.
            const customParamGroupNames = {};
            (instance.parameters || [])
                .filter(p => !PART_RESERVED_PARAM_NAMES.has(p.paramName) && !PART_RESERVED_PARAM_NAMES.has(p.simpleName))
                .forEach(p => {
                    const val = decodePartCustomParamValue(p);
                    if (val === undefined) return;
                    const key = p.simpleName || p.paramName;
                    customParams[key] = val;
                    if (p.displayName) customParamDisplayNames[key] = p.displayName;
                    const groups = groupsForKey(instance, key);
                    if (groups.length > 0) customParamGroupNames[key] = groups;
                });

            return {
                serial: modelId,
                childSerial: instance.obsBrandGoodId || '',
                partName: instance.name || '',
                partRefName: instance.refName || '',
                width: dim('W'), depth: dim('D'), height: dim('H'),
                positionX: pos.x, positionY: pos.y, positionZ: pos.z,
                rotateX: rot.x, rotateY: rot.y, rotateZ: rot.z,
                positionMethod: flag('invokedPosType'),
                partHideCondition: flag('ignore'),
                partReplaceable: flag('replaceable'),
                partQuotationRequired: flag('needQuotation'),
                partRemovable: flag('isDeletable'),
                partComponentRemovable: flag('cascadeDelete'),
                partStylePack: (modelPackageP && modelPackageP.value != null) ? modelPackageP.value : '',
                partBomOutput: flag('displayInCostList'),
                partParameterEditable: flag('paramOverride'),
                partIgnoreInternalInterference: flag('ignoreInnerIntersect'),
                partResetAfterSuppression: flag('resetWhenSuppress'),
                partSuppressCondition: flag('KJL_model_suppress_param'),
                customParams,
                customParamDisplayNames,
                customParamGroupNames
            };
        });
    }

    // =========================================================================
    // SECTION 5b4: DOOR OPENING EXTRACTION (editorData -> Door Opening sheet)
    // =========================================================================
    // Reverse of compileDoorOpeningRow. Door Openings (editorData.customDoorHoles)
    // aren't catalog parts — every one seen so far carries exactly the same
    // fixed 8 parameters, so unlike Parts there's no dynamic Custom
    // Parameters column here, just one column per field.
    const DOOR_EXPORT_HEADERS = [
        'Product serial number', 'Door Opening Name', 'Width', 'Height',
        'Position X', 'Position Y', 'Position Z', 'Rotate X', 'Rotate Y', 'Rotate Z',
        'Hide Conditions', 'Position Method', 'Door Opening Type', 'Minimum viable unit'
    ];

    function extractDoorOpeningsFromEditorData(ed, modelId) {
        return (ed.customDoorHoles || []).map(hole => {
            const find = (paramName) => (hole.parameters || []).find(p => p.paramName === paramName);
            const val = (paramName) => {
                const p = find(paramName);
                return (p && p.value != null) ? p.value : '';
            };
            const posP = find('position');
            const rotP = find('rotationDegree');
            const pos = decodeFloat3(posP && posP.value);
            const rot = decodeFloat3(rotP && rotP.value);
            return {
                serial: modelId,
                name: hole.name || '',
                width: val('width'), height: val('height'),
                positionX: pos.x, positionY: pos.y, positionZ: pos.z,
                rotateX: rot.x, rotateY: rot.y, rotateZ: rot.z,
                hideCondition: val('ignore'),
                positionMethod: val('invokedPosType'),
                doorOpeningType: val('calculateType'),
                adaptationUnit: val('adaptationUnit')
            };
        });
    }

    function selfHealReferencedVars(ed) {
        if (!ed.inputs) return;
        // Scoped to ed.inputs ONLY — a "#xyz" reference only ever resolves
        // against a SIBLING top-level parameter. Scanning the whole
        // editorData tree (previous behavior) also picked up every part's
        // own NESTED parameters[] — a real rejected save had a Shutter part
        // whose own local "Is_BSL" param referenced its own local
        // "#materialBrandGoodId" (that part's internal Material scriptName,
        // meaningless outside that part's scope). Since that name isn't in
        // top-level ed.inputs, this function tried to create it there too —
        // colliding with a system-reserved name ("引用名被系统占用"). Same
        // root cause as the earlier #getProductCustomAttr(...) bug: treating
        // an unrelated nested scope as if it were the top-level one.
        //
        // "#name(" is a formula FUNCTION CALL (e.g. #getProductCustomAttr(#CZ,
        // "MTY","NA")), not a variable reference either — confirmed
        // separately. \(?  captures an immediately-following '(' as part of
        // the SAME match so it can be filtered by string check below — a
        // lookahead here would be wrong, since backtracking a greedy
        // quantifier past a failed lookahead can silently produce a
        // shorter, truncated match instead of no match.
        const matches = JSON.stringify(ed.inputs).match(/#[a-zA-Z0-9_]+\(?/g) || [];
        const referenced = new Set(matches.filter(m => !m.endsWith('(')).map(m => m.slice(1)));
        const existing = new Set(ed.inputs.map(i => i.paramName));
        const builtins = new Set(['W', 'D', 'H', 'L']);
        referenced.forEach(v => {
            if (!existing.has(v) && !builtins.has(v)) {
                ed.inputs.push({
                    id: String(Date.now()) + Math.floor(Math.random() * 10000),
                    paramName: v, value: '0', valueType: 'float', displayName: v,
                    paramTypeId: 0, extAttr: {}, visible: true, generated: true
                });
            }
        });
    }

    // =========================================================================
    // SECTION 5b: PARTS (modelInstances[]) COMPILATION
    // =========================================================================
    // Captured verbatim via DevTools from a real, successful part-import: the
    // editor calls this GET the moment you pick a part to add, BEFORE any
    // save — response.editorModelInstances[0] is the ready-to-push
    // modelInstances entry, already carrying its own full `parameters[]` and
    // `customParamGroups[]` (nothing to hand-build there, unlike Global
    // Parameters). Only uniqueId/instanceId/refName come back null and need
    // filling in before it's pushed. isParentModelContainsCZ mirrors whether
    // THIS parent model has its own "CZ" (Material) input — confirmed by the
    // captured sample's Material param defaulting to `"value": "#CZ"` (a
    // reference to the parent's own #CZ) when that flag is true.
    async function fetchImportModelInstance(childObsBrandGoodId, parentHasCZ) {
        const origin = window.location.origin;
        const url = `${origin}/editor/api/site/import?obsbrandgoodid=${encodeURIComponent(childObsBrandGoodId)}&isParentModelContainsCZ=${parentHasCZ}&isAssembly=false`;
        const resp = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            mode: 'cors',
            headers: { accept: '*/*', 'editor-locale': 'en_US', 'x-qh-locale': 'en_US', 'x-qh-site': 'coohom' }
        });
        if (!resp.ok) throw new Error(`import lookup failed, status ${resp.status} (url: ${url})`);
        const json = await resp.json();
        const list = json.editorModelInstances;
        return (Array.isArray(list) && list.length > 0) ? list[0] : null;
    }

    // Matches the shape of existing uniqueIds seen in real editorData
    // (e.g. "g0a3ch0c27") — a short random base36 string.
    function generateUniqueId() {
        return Math.random().toString(36).slice(2, 12);
    }

    // instanceId is NOT scoped to ed.modelInstances — confirmed on a real
    // rejected save: frameModels[], moldingPaths[], and paramModel all carry
    // their own "instanceId" from the SAME shared numbering space (e.g. a
    // model's moldingPaths entries had instanceId "5"/"6" — assigning those
    // same values to new parts, because only modelInstances[] was scanned,
    // is exactly what triggered "instanceId重复或为空" on a live run). Scans
    // the whole editorData tree for every instanceId, same technique as
    // selfHealReferencedVars's JSON.stringify + regex scan below, so it
    // stays correct regardless of which other top-level arrays turn out to
    // share this id space.
    function nextInstanceId(ed) {
        const matches = JSON.stringify(ed).match(/"instanceId"\s*:\s*"?(\d+)"?/g) || [];
        let max = 0;
        matches.forEach(m => {
            const n = parseInt(m.match(/(\d+)/)[1], 10);
            if (n > max) max = n;
        });
        return String(max + 1);
    }

    // Shared by Parts and Door Openings — combines whichever X/Y/Z axes the
    // row actually supplied with whatever the target already had for the
    // other axes, into the {"x":...,"y":...,"z":...} JSON these float3
    // parameters (position/rotationDegree) are stored as.
    function combineFloat3Json(x, y, z, existingRaw) {
        let existing = {};
        try { existing = existingRaw ? JSON.parse(existingRaw) : {}; } catch (e) { existing = {}; }
        return JSON.stringify({
            x: x !== '' ? x : (existing.x !== undefined ? existing.x : '0'),
            y: y !== '' ? y : (existing.y !== undefined ? existing.y : '0'),
            z: z !== '' ? z : (existing.z !== undefined ? existing.z : '0')
        });
    }

    // Shared by Position Method on both Parts and Door Openings — a whole
    // number or formula passes straight through; anything else is resolved
    // as an OPTION NAME against the parameter's own real editorOptions
    // (never hardcoded, since different parts/openings can list these
    // differently), with an optional Chinese-label alias map as a fallback.
    // Returns { value } on success or { error } (just the "valid names:
    // ..." clause) on failure, so each caller can wrap it in its own
    // field/row-specific message.
    function resolveOptionNameValue(p, v, aliasMap) {
        if (isFormulaLike(v) || /^\d+$/.test(v)) return { value: v };
        const vLower = v.toLowerCase();
        let opt = (p.editorOptions || []).find(o => String(o.name).toLowerCase() === vLower);
        if (!opt && aliasMap && aliasMap[vLower]) {
            const aliases = aliasMap[vLower];
            opt = (p.editorOptions || []).find(o => aliases.includes(String(o.name)));
        }
        if (!opt) {
            const valid = (p.editorOptions || []).map(o => o.name).join(', ');
            return { error: `valid names: ${valid || '(none listed here)'}` };
        }
        return { value: opt.value };
    }

    // Door Opening Type (calculateType) is a plain enum, not a
    // formula-capable field like Position Method — accepts either the raw
    // stored value (so a downloaded sheet round-trips unedited, e.g.
    // "value"/"formula"/"general") or a human-typed option display name
    // ("Formula type").
    function resolveEnumOptionValue(p, v) {
        const opts = p.editorOptions || [];
        if (opts.some(o => String(o.value) === v)) return { value: v };
        const vLower = v.toLowerCase();
        const opt = opts.find(o => String(o.name).toLowerCase() === vLower);
        if (!opt) {
            const valid = opts.map(o => `${o.name} (${o.value})`).join(', ');
            return { error: `valid values: ${valid || '(none listed here)'}` };
        }
        return { value: opt.value };
    }

    // Returns an error string on failure, or undefined on success — same
    // convention as compileParamEditRow (the import lookup is async and can
    // genuinely fail). Add or Edit, decided by whether row.partRefName
    // matches an existing part's refName in this model — or, when
    // Reference name is blank, by Part Name instead (see below).
    async function compilePartEditRow(ed, row) {
        if (!ed.modelInstances) ed.modelInstances = [];

        // Edit path: a Reference name that already matches a part in this
        // model means "update that part", not "reject as duplicate" — this
        // is the same match-by-key-and-reuse pattern compileParamEditRow
        // already uses for top-level parameters (ed.inputs.find by
        // paramName). obsBrandGoodId alone can't disambiguate (the same
        // catalog part can legitimately be added more than once, e.g.
        // several identical screws), so a real key is still required.
        let instance = row.partRefName ? ed.modelInstances.find(mi => mi.refName === row.partRefName) : null;

        // Reference name blank — fall back to Part Name as the match key
        // (confirmed the hard way: leaving Reference name blank to edit an
        // existing part instead pushed 6 brand-new duplicate "PVC Leg"
        // parts, since blank refName used to mean "always add"). Only
        // matches when the name identifies exactly ONE existing part;
        // if the model already has more than one part sharing that same
        // Part Name, it's genuinely ambiguous which one the row means —
        // refuse to guess rather than silently editing/adding the wrong
        // one. No match at all still falls through to the Add path below,
        // same as a blank Reference name always has.
        if (!instance && !row.partRefName && row.partName) {
            const nameMatches = ed.modelInstances.filter(mi => mi.name === row.partName);
            if (nameMatches.length > 1) {
                return `Reference name is blank and Part Name '${row.partName}' matches ${nameMatches.length} existing parts on this model — ambiguous, refusing to guess which one to edit. Add a Reference name to identify exactly one part.`;
            }
            if (nameMatches.length === 1) instance = nameMatches[0];
        }

        if (instance) {
            if (row.partName) instance.name = row.partName;
        } else {
            // Add path: fetch the child's full definition and push a new
            // instance, same as before. Only reachable here when neither
            // Reference name nor Part Name matched an existing part — a
            // genuinely new part needs a real Child Serial Number to know
            // WHAT to add; a self-modeled/custom-geometry part with no
            // catalog id of its own can only ever be an edit, never an
            // add, so this is a real, actionable error rather than a
            // silent/confusing network failure.
            if (!row.childSerial) {
                return `Part '${row.partName || '(unnamed)'}' — no existing part matched by Reference name or Part Name, and Child Serial Number is blank, so there's nothing to add. If this part already exists on the model (e.g. a self-modeled part with no catalog id), set its Reference name or make its Part Name match exactly; a genuinely new part needs a real Child Serial Number to add from.`;
            }
            const parentHasCZ = (ed.inputs || []).some(i => i.paramName === 'CZ');
            let def;
            try {
                def = await fetchImportModelInstance(row.childSerial, parentHasCZ);
            } catch (e) {
                return `Part import lookup failed for Child Serial Number '${row.childSerial}': ${e.message}`;
            }
            if (!def) return `Part '${row.childSerial}' not found (import endpoint returned no editorModelInstances).`;

            instance = _.cloneDeep(def);
            instance.uniqueId = generateUniqueId();
            instance.instanceId = nextInstanceId(ed);
            if (row.partName) instance.name = row.partName;
            // Reference name is optional per row (confirmed) — but leaving
            // it as the import response's literal null broke on a real run
            // when several blank-refName rows landed in the SAME save:
            // server rejected it as "part reference name duplicate" (多
            // null 视为重复). Pre-existing null-refName parts in a model
            // are fine — those were each saved one at a time — but
            // multiple simultaneous nulls in one save batch are not. Fall
            // back to a name-derived, batch-unique value instead of
            // leaving it null.
            instance.refName = row.partRefName || deriveFallbackPartRefName(row.partName, instance.instanceId);
            ed.modelInstances.push(instance);
        }

        // Style Parameter -> functionName (add or edit alike). Only overwritten when supplied;
        // blank leaves the import response's own functionName as-is (the
        // normal, standalone case — see Shutter 2/3 vs Shutter 1 below).
        if (row.styleParameter) instance.functionName = row.styleParameter;

        // Style Pack -> the "modelPackage" entry inside instance.parameters.
        // Confirmed shape from a real sample: Shutter 1 (functionName
        // "#SD1", delegates to another instance) has modelPackage null;
        // Shutter 2 (standalone functionName) has a bare style-pack id
        // string; Shutter 3 (same standalone functionName) has a
        // {"cases":[...],"defaultValue":...} JSON block — both the bare-id
        // and the Condition-JSON form are stored verbatim, no wrapping.
        if (row.partStylePack) {
            const modelPackageParam = (instance.parameters || []).find(p => p.paramName === 'modelPackage');
            if (modelPackageParam) modelPackageParam.value = row.partStylePack;
        }

        // Width/Depth/Height -> W/D/H inside instance.parameters. A part's
        // own W/D/H can be paramTypeId 5 (Formula-driven internally, e.g.
        // Top Shelf's own Depth references @MF18.PTH) — confirmed not
        // overridable from the parent in that case, so this errors instead
        // of silently no-op'ing a value the user explicitly asked to set.
        for (const [paramName, val, label] of [['W', row.width, 'Width'], ['D', row.depth, 'Depth'], ['H', row.height, 'Height']]) {
            if (!val) continue;
            const p = (instance.parameters || []).find(x => x.paramName === paramName);
            if (!p) continue;
            if (p.paramTypeId === 5) {
                return `Cannot set ${label} on part '${row.partName}' — this part's own ${paramName} is Formula-driven internally (paramTypeId 5), not settable from the parent model.`;
            }
            p.value = val;
        }

        // Position/Rotate -> the "position"/"rotationDegree" float3 JSON.
        // Only the supplied axis is overridden; the other axes keep
        // whatever the import response already had (own default, usually
        // "0" for a fresh part).
        if (row.positionX !== '' || row.positionY !== '' || row.positionZ !== '') {
            const p = (instance.parameters || []).find(x => x.paramName === 'position');
            if (p) p.value = combineFloat3Json(row.positionX, row.positionY, row.positionZ, p.value);
        }
        if (row.rotateX !== '' || row.rotateY !== '' || row.rotateZ !== '') {
            const p = (instance.parameters || []).find(x => x.paramName === 'rotationDegree');
            if (p) p.value = combineFloat3Json(row.rotateX, row.rotateY, row.rotateZ, p.value);
        }

        // Position Method — see resolveOptionNameValue: confirmed on two
        // separate real samples (Origin=0, Lower Left Rear=2, Custom
        // baseline points=12) that this is read live off the part's own
        // definition rather than assumed, since different parts could
        // plausibly list these differently.
        if (row.positionMethod) {
            const p = (instance.parameters || []).find(x => x.paramName === 'invokedPosType');
            if (p) {
                const res = resolveOptionNameValue(p, row.positionMethod, POSITION_METHOD_ALIASES);
                if (res.error) return `Position Method '${row.positionMethod}' isn't a valid option for part '${row.partName}' — ${res.error}.`;
                p.value = res.value;
            }
        }

        // Remaining Design Attribute fields — plain value passthrough on the
        // matching instance.parameters entry. Utils.normalizeExpr handles
        // both a literal true/false and an AND/OR formula string uniformly,
        // same convention as Hide condition/Locked condition elsewhere.
        [
            ['partHideCondition', 'ignore'],
            ['partReplaceable', 'replaceable'],
            ['partQuotationRequired', 'needQuotation'],
            ['partRemovable', 'isDeletable'],
            ['partComponentRemovable', 'cascadeDelete'],
            ['partBomOutput', 'displayInCostList'],
            ['partParameterEditable', 'paramOverride'],
            ['partIgnoreInternalInterference', 'ignoreInnerIntersect'],
            ['partResetAfterSuppression', 'resetWhenSuppress'],
            ['partSuppressCondition', 'KJL_model_suppress_param']
        ].forEach(([rowKey, paramName]) => {
            const val = row[rowKey];
            if (!val) return;
            const p = (instance.parameters || []).find(x => x.paramName === paramName);
            if (p) p.value = Utils.normalizeExpr(val);
        });

        // Custom Parameters — arbitrary paramName/value pairs on the child
        // part's OWN parameters (its "Custom parameters" group — e.g.
        // materialBrandGoodId/CZ, VGF, or any of the many style-slot params
        // a Shutter part carries). One JSON array column rather than a
        // dedicated column per possible name, since different child parts
        // can each have entirely different custom parameter sets.
        //
        // Each entry's target valueType (read off the part's OWN existing
        // parameter, not guessed) decides how its value is written —
        // confirmed on three real samples per asset type (Top Shelf 1/2/3
        // for material, same set for the VGF style slot):
        //   - value starts with '#'  -> Reference: pass through as-is.
        //   - value starts with '{'  -> Condition: {"cases":[...],
        //     "defaultValue":...} block, each case value + defaultValue
        //     wrapped per Utils.wrapAssetValue, formulaForm set to 1.
        //   - otherwise              -> Direct: Utils.wrapAssetValue makes
        //     a bare id pass through for Material, or wrap into
        //     {"obsBrandGoodId":...,"versionId":0} for Style — same
        //     helper already used for top-level asset parameters.
        // Non-asset custom parameters (plain float/int/string/etc.) just
        // get the value passed through, same as the Design Attribute
        // fields above.
        // Two sources feed the same entry list: the wide per-column format
        // (row.customParamEntries, one entry per non-fixed CSV column —
        // this is what extractPartsFromEditorData now exports) and the
        // legacy single JSON-array column (row.customParameters), kept for
        // backward compatibility with older exported CSVs. Both are merged
        // so a hand-edited row mixing the two still works.
        let entries = (row.customParamEntries || []).slice();
        if (row.customParameters) {
            let legacyEntries;
            try {
                legacyEntries = JSON.parse(row.customParameters);
                if (!Array.isArray(legacyEntries)) throw new Error('expected a JSON array');
            } catch (e) {
                return `Custom Parameters is not a valid JSON array for part '${row.partName}': ${e.message}`;
            }
            entries = entries.concat(legacyEntries);
        }
        if (entries.length > 0) {
            for (const entry of entries) {
                if (!entry || !entry.paramName) return `Custom Parameters entry missing "paramName" for part '${row.partName}'.`;
                // Column header (or legacy JSON paramName) is matched
                // against the part's own simpleName first — that's the
                // friendlier alias shown/exported as the column header
                // (e.g. "CZ" for materialBrandGoodId) — falling back to
                // the raw internal paramName for parts/entries that don't
                // have one.
                const p = (instance.parameters || []).find(x => x.simpleName === entry.paramName || x.paramName === entry.paramName);
                if (!p) return `Custom parameter '${entry.paramName}' not found on part '${row.partName}'.`;
                const val = entry.value !== undefined && entry.value !== null ? String(entry.value) : '';
                if (['material', 'style', 'contour'].includes(p.valueType)) {
                    const trimmed = val.trim();
                    if (trimmed.startsWith('#')) {
                        p.value = val;
                        p.formulaForm = 0;
                    } else if (trimmed.startsWith('{') && trimmed.includes('"cases"')) {
                        let parsed;
                        try {
                            parsed = JSON.parse(trimmed);
                            if (!parsed || !Array.isArray(parsed.cases) || parsed.defaultValue === undefined) throw new Error('expected {"cases":[...],"defaultValue":...}');
                        } catch (e) {
                            return `Custom parameter '${entry.paramName}' value isn't a valid Condition JSON block for part '${row.partName}': ${e.message}`;
                        }
                        p.value = buildAssetFormulaConditionJson(parsed, p.valueType);
                        p.formulaForm = 1;
                    } else {
                        p.value = Utils.wrapAssetValue(val, p.valueType);
                        p.formulaForm = 0;
                    }
                } else {
                    p.value = Utils.normalizeExpr(val);
                }
            }
        }
    }

    // Edit-only — no Add path (see DOOR_OPENING_EDIT's TASK_REGISTRY note):
    // a Door Opening is matched by its exact Name (e.g. "Door Opening-1")
    // against editorData.customDoorHoles, never created. Mirrors
    // compilePartEditRow's own field-by-field dispatch, scaled down to the
    // fixed 8 fields every Door Opening actually has.
    async function compileDoorOpeningRow(ed, row) {
        const instance = (ed.customDoorHoles || []).find(h => h.name === row.name);
        if (!instance) {
            return `Door Opening '${row.name}' not found on this model — this sheet edits existing Door Openings only (matched by exact Name); add it in the model editor first, or check for a typo.`;
        }
        const find = (paramName) => (instance.parameters || []).find(x => x.paramName === paramName);

        // Width/Height — formula-capable text fields (real samples carry
        // formulas like "#H-@BTS.H-30-25" as their normal, non-override
        // value), so passed through Utils.normalizeExpr rather than
        // restricted to numeric-only.
        for (const [paramName, val] of [['width', row.width], ['height', row.height]]) {
            if (!val) continue;
            const p = find(paramName);
            if (p) p.value = Utils.normalizeExpr(val);
        }

        if (row.positionX !== '' || row.positionY !== '' || row.positionZ !== '') {
            const p = find('position');
            if (p) p.value = combineFloat3Json(row.positionX, row.positionY, row.positionZ, p.value);
        }
        if (row.rotateX !== '' || row.rotateY !== '' || row.rotateZ !== '') {
            const p = find('rotationDegree');
            if (p) p.value = combineFloat3Json(row.rotateX, row.rotateY, row.rotateZ, p.value);
        }

        if (row.hideCondition) {
            const p = find('ignore');
            if (p) p.value = Utils.normalizeExpr(row.hideCondition);
        }

        if (row.positionMethod) {
            const p = find('invokedPosType');
            if (p) {
                const res = resolveOptionNameValue(p, row.positionMethod, POSITION_METHOD_ALIASES);
                if (res.error) return `Position Method '${row.positionMethod}' isn't a valid option for Door Opening '${row.name}' — ${res.error}.`;
                p.value = res.value;
            }
        }

        if (row.doorOpeningType) {
            const p = find('calculateType');
            if (p) {
                const res = resolveEnumOptionValue(p, row.doorOpeningType);
                if (res.error) return `Door Opening Type '${row.doorOpeningType}' isn't valid for Door Opening '${row.name}' — ${res.error}.`;
                p.value = res.value;
            }
        }

        if (row.adaptationUnit) {
            const p = find('adaptationUnit');
            if (p) p.value = Utils.normalizeExpr(row.adaptationUnit);
        }
    }

    // Alphanumeric/underscore only, matching the paramName convention used
    // elsewhere — suffixed with instanceId (already guaranteed unique per
    // model) so two rows with the same Part Name can't collide either.
    function deriveFallbackPartRefName(partName, instanceId) {
        const base = String(partName || 'PART').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) || 'PART';
        return `${base}_${instanceId}`;
    }

    function checkDeletionDependencies(ed, rows, protectedNames) {
        const deletedNames = new Set(rows.map(r => r.refName));
        const inputs = ed.inputs || [];
        const protectedSet = protectedNames || new Set();
        // Precise pass: sibling ed.inputs, same as before — gives a
        // specific "referenced in the X of Y" message when the dependency
        // is another parameter.
        for (const r of rows) {
            const search = '#' + r.refName;
            for (const inp of inputs) {
                if (inp.paramName === r.refName) continue;
                if (deletedNames.has(inp.paramName)) continue;
                let field = null;
                if (inp.formula && String(inp.formula).includes(search)) field = 'formula';
                else if (inp.link && String(inp.link).includes(search)) field = 'link';
                else if (inp.value && String(inp.value).includes(search)) field = 'value';
                else if (inp.ignore && String(inp.ignore).includes(search)) field = 'hide condition';
                // A Range parameter's own Minimum/Maximum can hold a "#ref"
                // formula (e.g. Width's Max was "#KMFX == 0 ... ? 600 :
                // 1200") — missed here before, so deleting KMFX while W
                // stayed (protected) passed this check silently and only
                // failed server-side with "Variable maximum boundary error".
                else if (inp.min && String(inp.min).includes(search)) field = 'minimum';
                else if (inp.max && String(inp.max).includes(search)) field = 'maximum';
                if (!field) continue;
                // A protected/system parameter (W/D/H/CZ, or anything
                // grouped "System parameters") is being kept regardless —
                // per user instruction, a stale reference FROM one of
                // those to something now being deleted is cleaned up
                // instead of blocking the whole batch. A CUSTOM parameter
                // referencing another custom parameter being kept is a
                // real design conflict, still reported instead of
                // silently rewritten.
                if (protectedSet.has(inp.paramName)) {
                    // Blanking min/max outright breaks a Range-type
                    // parameter structurally (Range requires a real
                    // max/min) — confirmed the hard way: clearing W's max
                    // to '' after deleting KMFX passed our own check but
                    // was rejected server-side as "[W] Variable maximum
                    // boundary error", since a blank max isn't valid on a
                    // Range param. Substituting the deleted parameter's
                    // OWN CURRENT VALUE in place of every "#refName" it's
                    // referenced by keeps the field's math/text valid and
                    // preserves the parameter's presently-evaluated
                    // behavior, instead of leaving a dangling reference.
                    const deletedInput = inputs.find(i => i.paramName === r.refName);
                    const hasReplacement = deletedInput && deletedInput.value !== undefined && deletedInput.value !== null && deletedInput.value !== '';
                    const literal = hasReplacement ? String(deletedInput.value) : null;
                    const re = new RegExp('#' + r.refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'g');
                    const substitute = (text) => literal !== null ? String(text).replace(re, literal) : null;
                    if (field === 'formula') inp.formula = substitute(inp.formula);
                    else if (field === 'link') inp.link = substitute(inp.link);
                    else if (field === 'value') inp.value = literal !== null ? substitute(inp.value) : '';
                    else if (field === 'hide condition') inp.ignore = substitute(inp.ignore);
                    else if (field === 'minimum') inp.min = literal !== null ? substitute(inp.min) : '0';
                    else if (field === 'maximum') inp.max = literal !== null ? substitute(inp.max) : '0';
                    continue;
                }
                return `Cannot delete '${r.refName}' — referenced in the ${field} of '${inp.paramName}'.`;
            }
        }
        // Structural pass: the model's own geometry (frameModels,
        // moldingPaths, modelInstances, paramModel, etc.) can ALSO
        // reference a parameter via "#name" directly — confirmed on a real
        // sample (frameModels' own "size" param held "#W"/"#D"/"#H",
        // "materialBrandGoodId" held "#CZ"). Deleting a structurally
        // referenced parameter like W/D/H/CZ used to pass this check
        // silently and only fail later, server-side, with an unhelpful
        // generic error ("属性错误").
        const edWithoutInputs = Object.assign({}, ed);
        delete edWithoutInputs.inputs; // already covered by the precise pass above
        const wholeText = JSON.stringify(edWithoutInputs);
        for (const r of rows) {
            if (wholeText.includes('#' + r.refName)) {
                return `Cannot delete '${r.refName}' — it's referenced in the model's own structure (geometry, a part, or similar), not just in another parameter. Removing it would break that reference.`;
            }
        }
        return null;
    }

    // A part instance is referenced elsewhere as "@refName.field" (e.g.
    // "@VG.H", "@VG.W" — confirmed on real VDFX/VDFY/VT rows). Boundary
    // check (not followed by another identifier char) so deleting "VG"
    // doesn't false-positive on a sibling part named "VG2".
    function partRefUsed(text, refName) {
        const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('@' + escaped + '(?![A-Za-z0-9_])').test(text);
    }

    // `targetRows` (must have partRefName — only a named part can be
    // pointed at by "@refName") are what's being searched FOR.
    // `deletedInstances` (every resolved instance in this batch, named or
    // not) are what's excluded from the scan — a blank-refName part being
    // deleted in the SAME batch can still hold its own "@OtherPart" formula
    // in its own subtree, and that must not count as an external
    // dependency any more than a named one would.
    function checkPartDeletionDependencies(ed, targetRows, deletedInstances) {
        const inputs = ed.inputs || [];
        // Precise pass: sibling ed.inputs — gives a specific "referenced in
        // the X of Y" message when the dependency is a top-level parameter
        // (same idea as checkDeletionDependencies, but for "@refName" part
        // references instead of "#refName" parameter references).
        for (const r of targetRows) {
            for (const inp of inputs) {
                let field = null;
                if (inp.formula && partRefUsed(String(inp.formula), r.partRefName)) field = 'formula';
                else if (inp.value && partRefUsed(String(inp.value), r.partRefName)) field = 'value';
                else if (inp.ignore && partRefUsed(String(inp.ignore), r.partRefName)) field = 'hide condition';
                if (field) return `Cannot delete part '${r.partRefName}' — referenced (as '@${r.partRefName}...') in the ${field} of parameter '${inp.paramName}'.`;
            }
        }
        // Structural pass: other parts' own parameters, frameModels,
        // moldingPaths, etc. can reference this part too. Exclude every
        // instance being deleted in this batch from the scan by identity
        // (uniqueId — present on every real modelInstance, confirmed;
        // refName alone isn't enough since a blank-refName part being
        // deleted would otherwise still show up as its own "dependency").
        const deletedUniqueIds = new Set((deletedInstances || []).map(mi => mi.uniqueId).filter(Boolean));
        const edCopy = _.cloneDeep(ed);
        edCopy.modelInstances = (edCopy.modelInstances || []).filter(mi => !deletedUniqueIds.has(mi.uniqueId));
        const wholeText = JSON.stringify(edCopy);
        for (const r of targetRows) {
            if (partRefUsed(wholeText, r.partRefName)) {
                return `Cannot delete part '${r.partRefName}' — it's referenced (as '@${r.partRefName}...') elsewhere in the model (another part, parameter, or structure). Removing it would break that reference.`;
            }
        }
        return null;
    }

    // Resolves which live part instance(s) a PART_DEL row identifies.
    // Reference name is exact and unambiguous when given (a model can't
    // have two parts sharing one refName). When it's blank, Child Serial
    // Number narrows to every instance imported from that same catalog
    // part — which can legitimately be more than one (e.g. two identical
    // screws) — so Part Name is applied on top as a second filter to land
    // on exactly one. Never guesses between multiple survivors; that's
    // reported back as an error instead of picking one.
    //
    // NOTE: matches Child Serial Number against instance.obsBrandGoodId —
    // inferred from the same key name Kujiale uses everywhere else for a
    // model's catalog id (the "obsbrandgoodid" URL param, the
    // {obsBrandGoodId,versionId} asset value shape), not yet confirmed
    // against a captured modelInstances[] entry. Reference name / Part Name
    // matching (refName / name) IS confirmed. If a Child-Serial-only row
    // comes back "not found" unexpectedly, send the real modelInstances[]
    // entry for that part and this gets corrected.
    function findPartInstancesToDelete(ed, row) {
        const instances = ed.modelInstances || [];
        if (row.partRefName) {
            return { matches: instances.filter(mi => mi.refName === row.partRefName), label: `Reference name '${row.partRefName}'` };
        }
        let candidates = instances;
        let label = '';
        if (row.childSerial) {
            candidates = candidates.filter(mi => mi.obsBrandGoodId === row.childSerial);
            label = `Child Serial Number '${row.childSerial}'`;
        }
        if (row.partName) {
            candidates = candidates.filter(mi => mi.name === row.partName);
            label = label ? `${label} + Part Name '${row.partName}'` : `Part Name '${row.partName}'`;
        }
        return { matches: candidates, label };
    }

    // =========================================================================
    // SECTION 6: EXECUTION ENGINE
    // =========================================================================
    runBtn.onclick = async () => {
        runBtn.innerText = '⏳ Processing...'; runBtn.disabled = true; runBtn.style.pointerEvents = 'none';
        lastRunErrors = [];
        let s = 0, f = 0, done = 0;
        const total = parsedData.size;
        for (const [id, data] of parsedData) {
            try {
                const res = await processModel(id, data);
                if (res.ok) s++; else { f++; lastRunErrors.push({ id, msg: res.msg || 'Unknown error' }); }
            } catch (e) {
                f++; lastRunErrors.push({ id, msg: e.message || String(e) });
            }
            done++;
            document.getElementById('sync-stats').innerText = `S:${s} | F:${f}`;
            document.getElementById('progress-label').innerText = `${done}/${total} processed`;
        }
        runBtn.innerText = 'Run Finished';
        if (lastRunErrors.length > 0) document.getElementById('run-error-download').style.display = 'block';
        if (f === 0) showNotification(`✅ All models (${s}) successfully updated!`, THEME.success);
        else showNotification(`⚠️ Finished with ${f} error(s). Download the run error report.`, THEME.warning);
    };

    function currentToolType() {
        return window.location.href.includes('cabinet') ? 'cabinet' : 'wardrobe';
    }

    // Every "Failed to fetch" seen in batch runs is a bare TypeError from
    // fetch() itself — connection reset/dropped mid-request, never an HTTP
    // status (those are handled separately via resp.ok). Confirmed via
    // native-UI "Copy as fetch" comparison that the request shape itself is
    // correct, so a single transient network blip shouldn't fail an entire
    // model. Retries ONLY the network-layer throw, never a resolved
    // response — a real 4xx/5xx still surfaces immediately to the caller.
    async function fetchWithRetry(url, opts, attempts = 3, delayMs = 1500) {
        for (let i = 0; i < attempts; i++) {
            try {
                return await fetch(url, opts);
            } catch (e) {
                if (i === attempts - 1) throw e;
                await new Promise(r => setTimeout(r, delayMs * (i + 1)));
            }
        }
    }

    async function processModel(modelId, data) {
        const origin = window.location.origin;
        const tool = currentToolType();
        const hdrs = { "accept": "*/*", "editor-locale": "zh_CN" };

        let resp;
        try {
            resp = await fetchWithRetry(`${origin}/editor/api/site/editordata?obsbrandgoodid=${modelId}&tooltype=${tool}`, { headers: hdrs, credentials: 'include' });
        } catch (e) {
            return { ok: false, msg: `GET network error: ${e.message}` };
        }
        if (!resp.ok) return { ok: false, msg: `GET failed, status ${resp.status}` };
        const json = await resp.json();
        const ed = json.editorData;
        if (!ed) return { ok: false, msg: 'No editorData in response.' };
        const original = _.cloneDeep(ed);

        if (currentTask.id === 'QUOTE') {
            if (!ed.outputConfig) ed.outputConfig = {};
            if (!ed.outputConfig.quotationConfig) ed.outputConfig.quotationConfig = {};
            if (!ed.outputConfig.quotationConfig.customSize) ed.outputConfig.quotationConfig.customSize = {};
            const cs = ed.outputConfig.quotationConfig.customSize;
            if (data.w) cs.x = Utils.normalizeExpr(data.w);
            if (data.d) cs.y = Utils.normalizeExpr(data.d);
            if (data.h) cs.z = Utils.normalizeExpr(data.h);
        } else if (currentTask.id === 'PARAM_EDIT') {
            for (const row of data) {
                const rowErr = await compileParamEditRow(ed, row);
                if (rowErr) return { ok: false, msg: rowErr };
            }
            selfHealReferencedVars(ed);
        } else if (currentTask.id === 'PARAM_DEL') {
            const protectedNames = new Set([...PROTECTED_PARAM_NAMES, ...lastDeleteSkippedProtected]);
            const depErr = checkDeletionDependencies(ed, data, protectedNames);
            if (depErr) return { ok: false, msg: depErr };
            const names = new Set(data.map(r => r.refName));
            ed.inputs = (ed.inputs || []).filter(inp => !names.has(inp.paramName));
            // A deleted parameter can still have an IMOS Output Condition
            // entry in outputConfig.productionParams[] pointing at it —
            // left behind, the server rejects the save as a dangling
            // output-mapping reference ("数据输出设置错误").
            if (ed.outputConfig && Array.isArray(ed.outputConfig.productionParams)) {
                ed.outputConfig.productionParams = ed.outputConfig.productionParams.filter(p => !names.has(p.paramName));
            }
            names.forEach(n => removeFromAllGroups(ed, n));
            // A system/protected parameter listed in the Delete CSV isn't
            // actually deleted (see PROTECTED_PARAM_NAMES above) — reset it
            // instead, preferring (in order): an explicit Value from the
            // CSV row itself, then the live category default fetched from
            // Kujiale's own template/new endpoint. No hardcoded fallback —
            // if the live fetch fails, that parameter is simply left
            // untouched (same as if it were never listed) rather than
            // guessing a value.
            //
            // For W/D/H/CZ specifically, a live-default reset replaces the
            // ENTIRE definition (paramTypeId/formula/link/min/max/etc.),
            // not just the value — confirmed necessary the hard way: the
            // template's D is a plain Range float, but a real model's D
            // can be Formula-driven ("@MF18.PTH", paramTypeId 5), and
            // forcing just the template's literal value onto that shape
            // got rejected server-side ("[D] Invalid parameter value").
            // `id` and `extAttr` (which carries the Locked-condition flag)
            // are preserved from the live entry regardless, since those
            // are per-model identity/state, not part of what "default"
            // means. Every other protected name (KMFX, BSWZ, etc.) keeps
            // the simpler value-only reset, since their shape never
            // varies between a template and a live model.
            const protectedThisModel = deleteProtectedNamesPerModel.get(modelId);
            if (protectedThisModel && protectedThisModel.size > 0) {
                const explicitResets = deleteResetValues.get(modelId) || new Map();
                const needsLiveLookup = [...protectedThisModel].some(n => !explicitResets.has(n));
                let liveDefaults = null;
                if (needsLiveLookup) {
                    try {
                        liveDefaults = await fetchCategoryDefaults(CONFIG.PRODCATID);
                    } catch (e) {
                        liveDefaults = null; // live lookup failed — nothing to fall back to, leave unresolved names untouched
                    }
                }
                for (const refName of protectedThisModel) {
                    const input = (ed.inputs || []).find(i => i.paramName === refName);
                    if (!input) continue;
                    if (explicitResets.has(refName)) {
                        input.value = Utils.normalizeExpr(String(explicitResets.get(refName)));
                        continue;
                    }
                    const templateEntry = liveDefaults && liveDefaults.get(refName);
                    if (!templateEntry) continue;
                    if (PROTECTED_PARAM_NAMES.has(refName)) {
                        // Object.assign alone only OVERWRITES keys present
                        // in templateEntry — it can't CLEAR a key the live
                        // model customized that the template simply never
                        // had (e.g. D's "formula":"@MF18.PTH", or CZ's
                        // conditional "link" + linkForm:1). Left in place,
                        // that stale field coexists with the template's new
                        // paramTypeId and produces an inconsistent hybrid —
                        // confirmed as the actual cause of "公式执行失败":
                        // a Range-typed D still carrying an active formula,
                        // an Unlimited-typed CZ still carrying an active
                        // conditional link. Starting from a neutral
                        // skeleton first guarantees every field the
                        // template doesn't specify is genuinely cleared,
                        // not just left behind.
                        const neutral = newInputSkeleton(refName, input.displayName || refName);
                        const preservedId = input.id;
                        const preservedExtAttr = input.extAttr;
                        Object.assign(input, neutral, templateEntry, { id: preservedId, extAttr: preservedExtAttr, paramName: refName });
                    } else {
                        if (templateEntry.value === undefined || templateEntry.value === null || templateEntry.value === '') continue;
                        input.value = templateEntry.value;
                    }
                }
            }
        } else if (currentTask.id === 'PART_EDIT') {
            for (const row of data) {
                const rowErr = await compilePartEditRow(ed, row);
                if (rowErr) return { ok: false, msg: rowErr };
            }
        } else if (currentTask.id === 'PART_DEL') {
            const resolved = [];
            for (const row of data) {
                const idLabel = `Child Serial Number '${row.childSerial || ''}' / Part Name '${row.partName || ''}' / Reference name '${row.partRefName || ''}'`;
                const { matches, label } = findPartInstancesToDelete(ed, row);
                if (matches.length === 0) {
                    return { ok: false, msg: `No part found matching ${label || idLabel} on this model.` };
                }
                if (matches.length > 1) {
                    const names = matches.map(m => `'${m.name || '(unnamed)'}'${m.refName ? ` (ref: ${m.refName})` : ''}`).join(', ');
                    return { ok: false, msg: `${matches.length} parts match ${label} — ambiguous, refusing to guess. Matches: ${names}. Add Part Name and/or Reference name to identify exactly one.` };
                }
                resolved.push(matches[0]);
            }
            // Dependency check only needs a search target for parts that
            // have a refName — a blank-refName part can't be pointed at by
            // anyone as "@refName." in the first place — but EVERY resolved
            // instance (refName or not) must be excluded from the scan, so
            // pass the full batch separately for that.
            const depRows = resolved.filter(mi => mi.refName).map(mi => ({ partRefName: mi.refName }));
            if (depRows.length > 0) {
                const depErr = checkPartDeletionDependencies(ed, depRows, resolved);
                if (depErr) return { ok: false, msg: depErr };
            }
            ed.modelInstances = (ed.modelInstances || []).filter(mi => !resolved.includes(mi));
        } else if (currentTask.id === 'DOOR_OPENING_EDIT') {
            for (const row of data) {
                const rowErr = await compileDoorOpeningRow(ed, row);
                if (rowErr) return { ok: false, msg: rowErr };
            }
        }

        if (_.isEqual(original, ed)) return { ok: true };

        const bodyStr = JSON.stringify(ed);
        const validation = await callValidateApi(bodyStr, ed.inputs);
        if (!validation.ok) return { ok: false, msg: validation.msg };

        let save;
        try {
            save = await fetchWithRetry(`${origin}/editor/api/site/editordata`, {
                method: 'POST', credentials: 'include',
                headers: { "content-type": "text/plain;utf-8", ...hdrs },
                body: JSON.stringify({ editorData: ed, paramModelInfo: json.paramModelInfo })
            });
        } catch (e) {
            return { ok: false, msg: `POST network error: ${e.message}` };
        }
        if (!save.ok) return { ok: false, msg: `POST failed, status ${save.status}` };

        try {
            await fetchWithRetry(`${origin}/editortask/editordata/review`, {
                method: 'POST', credentials: 'include',
                headers: { "content-type": "application/json", ...hdrs },
                body: JSON.stringify({ obsBrandGoodIds: [modelId], skipTest: CONFIG.REVIEW_SKIP_TEST, toolType: tool })
            });
        } catch (e) {
            return { ok: false, msg: `Save succeeded but review call failed: ${e.message}` };
        }
        return { ok: true };
    }

    // Common Kujiale backend error phrases -> readable English.
    const ZH_TO_EN = {
        '参数值错误': 'Invalid parameter value',
        '值不能为空': 'Value cannot be empty',
        '未找到对应的模型': 'Corresponding model not found',
        '模型数据损坏': 'Model data is corrupt',
        '变量最小值错误': 'Variable minimum boundary error',
        '变量最大值错误': 'Variable maximum boundary error',
        '变量默认值错误': 'Variable default value error',
        '数据输出设置错误': 'Production output mapping error (dangling reference)',
        '变量可选值存在错误': 'Option configuration error (invalid ignore expression or undefined variable reference)'
    };
    function translateServerMsg(msg) {
        if (!msg) return msg;
        for (const [zh, en] of Object.entries(ZH_TO_EN)) {
            if (msg.includes(zh)) return `${en} (${msg})`;
        }
        return msg;
    }

    // `inputs` is the compiled ed.inputs array at validate-time — used to
    // resolve a validateResults[].stack.location entry back to the specific
    // parameter it's complaining about, since the server never names it
    // directly ("参数值错误" alone gives no clue which of N parameters failed).
    async function callValidateApi(bodyStr, inputs) {
        try {
            const resp = await fetchWithRetry(`${window.location.origin}/editor/api/site/3d?prodcatid=${CONFIG.PRODCATID}&compress=false`, {
                method: 'POST', credentials: 'include',
                headers: { "accept": "*/*", "content-type": "text/plain;utf-8", "editor-locale": "zh_CN" },
                body: bodyStr
            });
            const text = await resp.text();
            let data;
            // A non-JSON response here means the server crashed outright
            // (HTTP 500 + generic error page) rather than rejecting the
            // payload with a normal validateResults entry — no field/row
            // pointer available the way a type:1 result gives us. Keep
            // more of the raw text than before (was 200 chars, often cut
            // off before anything past a generic <title>) in case a future
            // occurrence's page actually names something useful.
            try { data = JSON.parse(text); } catch (e) { return { ok: false, msg: `Validation endpoint returned non-JSON (status ${resp.status}): ${text.slice(0, 1000)}` }; }
            if (Array.isArray(data.validateResults) && data.validateResults.some(r => r.type === 1)) {
                const msgs = data.validateResults.filter(r => r.type === 1).map(r => {
                    let paramName = null;
                    if (r.stack && Array.isArray(r.stack.location)) {
                        r.stack.location.forEach(l => {
                            if (l.fieldName === 'inputs' && l.index !== undefined && inputs && inputs[l.index]) {
                                paramName = inputs[l.index].paramName;
                            }
                        });
                    }
                    const raw = r.info || r.message || JSON.stringify(r);
                    const translated = translateServerMsg(raw);
                    return paramName ? `[${paramName}] ${translated}` : translated;
                });
                return { ok: false, msg: `Server validation failed: ${msgs.join('; ')}` };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, msg: `Validation call error: ${e.message}` };
        }
    }

    // =========================================================================
    // SECTION 7: DEBUGGER & DRAGGABLE LOGIC
    // =========================================================================
    function openDebugger() {
        const existing = document.getElementById('debug-modal'); if (existing) return;
        const d = document.createElement('div'); d.id = 'debug-modal';
        Object.assign(d.style, { position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', width: '450px', maxWidth: 'calc(100vw - 40px)', height: '550px', maxHeight: 'calc(100vh - 100px)', background: '#fff', zIndex: '100001', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', border: '1px solid #ddd', overflow: 'hidden' });
        d.innerHTML = `<div style="padding:12px; background:#f5f5f7; border-bottom:1px solid #eee; font-size:10px; font-weight:bold; display:flex; justify-content:space-between;">JSON EXTRACTOR <span id="close-debug" style="cursor:pointer; font-size:14px; color:#aaa;">✕</span></div>
            <div style="padding:12px; flex:1; display:flex; flex-direction:column; gap:10px;">
                <div style="display:flex; gap:6px;"><input id="debug-id" placeholder="Enter ID..." style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px; font-size:11px; outline:none;"><button id="do-clear" style="padding:0 12px; background:#f0f0f2; border:none; border-radius:6px; font-size:11px; cursor:pointer;">Clear</button></div>
                <button id="do-fetch" style="width:100%; padding:10px; background:#0071e3; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-weight:bold;">Extract JSON</button>
                <textarea id="debug-res" readonly style="flex:1; width:100%; font-family:monospace; font-size:10.5px; padding:10px; border:1px solid #eee; background:#fafafa; border-radius:6px; outline:none; resize:none;"></textarea>
                <button id="do-copy" style="width:100%; padding:10px; background:#1d1d1f; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-weight:bold;">Copy JSON</button>
            </div>`;
        document.body.appendChild(d);
        const idIn = d.querySelector('#debug-id'); const resA = d.querySelector('#debug-res');
        d.querySelector('#close-debug').onclick = () => { d.remove(); };
        d.querySelector('#do-clear').onclick = () => { idIn.value = ''; resA.value = ''; };
        d.querySelector('#do-copy').onclick = () => { resA.select(); document.execCommand('copy'); const b = d.querySelector('#do-copy'); const old = b.innerText; b.innerText = '✅ Copied!'; setTimeout(() => { b.innerText = old; }, 2000); };
        d.querySelector('#do-fetch').onclick = async () => {
            const id = idIn.value.trim(); if (!id) return; resA.value = "Fetching...";
            const tool = currentToolType();
            try {
                const r = await fetch(`${window.location.origin}/editor/api/site/editordata?obsbrandgoodid=${id}&tooltype=${tool}`, { credentials: 'include' });
                const j = await r.json();
                resA.value = JSON.stringify(j.editorData, null, 4);
            } catch (e) { resA.value = "Fail: " + (e.message || e); }
        };
    }

    // Pulls one or more live models' current parameters (top-level
    // ed.inputs[], same scope the Parameter Add/Delete sheets cover) and
    // writes them out via extractParamsFromEditorData(), so an existing
    // model can be reviewed/edited as a CSV instead of read back out of raw
    // JSON by hand.
    async function fetchEditorDataFor(id, tool) {
        const r = await fetchWithRetry(`${window.location.origin}/editor/api/site/editordata?obsbrandgoodid=${encodeURIComponent(id)}&tooltype=${tool}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`GET failed, status ${r.status}`);
        const j = await r.json();
        if (!j.editorData) throw new Error('No editorData in response.');
        return j.editorData;
    }

    function openExtractor() {
        const existing = document.getElementById('extract-modal'); if (existing) return;
        const d = document.createElement('div'); d.id = 'extract-modal';
        // Centered via left:50%/translateX rather than a fixed left offset —
        // a hardcoded left:700px could land off-screen on a narrower window
        // (confirmed: this is why the modal wasn't appearing to click).
        Object.assign(d.style, { position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', width: '450px', maxWidth: 'calc(100vw - 40px)', height: '610px', maxHeight: 'calc(100vh - 100px)', background: '#fff', zIndex: '100001', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', border: '1px solid #ddd', overflow: 'hidden' });
        d.innerHTML = `<div style="padding:12px; background:#f5f5f7; border-bottom:1px solid #eee; font-size:10px; font-weight:bold; display:flex; justify-content:space-between;">EXTRACTOR <span id="close-extract" style="cursor:pointer; font-size:14px; color:#aaa;">✕</span></div>
            <div style="padding:12px; flex:1; display:flex; flex-direction:column; gap:10px;">
                <div style="font-size:10px; color:#888;">One Model ID per line (or comma-separated).</div>
                <textarea id="extract-ids" placeholder="3FO3EYXBY6I1&#10;3FO3G5M9IGV2&#10;..." style="width:100%; height:90px; font-family:monospace; font-size:11px; padding:8px; border:1px solid #ddd; border-radius:6px; outline:none; resize:none; box-sizing:border-box;"></textarea>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button id="do-extract-params" style="flex:1; min-width:110px; padding:10px; background:#0071e3; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-weight:bold;">Extract Parameters</button>
                    <button id="do-extract-parts" style="flex:1; min-width:110px; padding:10px; background:#1d1d1f; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-weight:bold;">Extract Parts</button>
                    <button id="do-extract-doors" style="flex:1; min-width:110px; padding:10px; background:${THEME.indigo}; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-weight:bold;">Extract Door Openings</button>
                </div>
                <textarea id="extract-log" readonly style="flex:1; width:100%; font-family:monospace; font-size:10.5px; padding:10px; border:1px solid #eee; background:#fafafa; border-radius:6px; outline:none; resize:none;"></textarea>
            </div>`;
        document.body.appendChild(d);
        const idsIn = d.querySelector('#extract-ids'); const logA = d.querySelector('#extract-log');
        const paramsBtn = d.querySelector('#do-extract-params'); const partsBtn = d.querySelector('#do-extract-parts');
        const doorBtn = d.querySelector('#do-extract-doors');
        d.querySelector('#close-extract').onclick = () => { d.remove(); };

        // Shared by all three buttons — only what happens per-model
        // (extractFn, unit label) and the download call differ.
        async function runExtraction(btn, defaultLabel, extractFn, unitLabel, download) {
            const ids = [...new Set(idsIn.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean))];
            if (ids.length === 0) return;
            paramsBtn.disabled = true; partsBtn.disabled = true; doorBtn.disabled = true; btn.innerText = 'Extracting...';
            const tool = currentToolType();
            const allRows = []; const errors = [];
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                logA.value = `Fetching ${i + 1}/${ids.length}: ${id}...`;
                try {
                    const ed = await fetchEditorDataFor(id, tool);
                    const rows = extractFn(ed, id);
                    allRows.push(...rows);
                    logA.value += ` ✅ ${rows.length} ${unitLabel}\n`;
                } catch (e) {
                    errors.push(`${id}: ${e.message || e}`);
                    logA.value += ` ❌ ${e.message || e}\n`;
                }
            }
            if (allRows.length > 0) download(allRows);
            logA.value += `\nDone. ${allRows.length} ${unitLabel} from ${ids.length - errors.length}/${ids.length} model(s).`;
            if (errors.length > 0) logA.value += `\n\nFailed:\n${errors.join('\n')}`;
            paramsBtn.disabled = false; partsBtn.disabled = false; doorBtn.disabled = false; btn.innerText = defaultLabel;
        }

        paramsBtn.onclick = () => runExtraction(paramsBtn, 'Extract Parameters', extractParamsFromEditorData, 'parameter(s)', (allRows) => {
            downloadCsvReport(allRows, 'params_extract', PARAM_EXPORT_HEADERS, r => [
                r.productName, r.serial, r.paramCategory, r.grouping, r.paramType, r.dataType,
                r.displayName, r.paramName, r.value, r.min, r.max, r.step, r.options, r.expression,
                r.hideCondition, r.lockedCondition, r.imosOutputCondition, r.defaultState,
                r.compositeType, r.valueRelationship, r.materialRange, r.expressionType
            ]);
        });

        partsBtn.onclick = () => runExtraction(partsBtn, 'Extract Parts', extractPartsFromEditorData, 'part(s)', (allRows) => {
            const allKeys = new Set(allRows.flatMap(r => Object.keys(r.customParams || {})));
            const displayNameByKey = {};
            // A key can genuinely belong to more than one group — the same
            // key can be filed differently at the model level vs. on a
            // given part, or under several of a part's own groups at once
            // (e.g. "PM_VISIBLE_LEFT" under both "Link Parameters" and
            // "IMOS System Link Parameters" on the same part). Every group
            // name seen for a key, from any part, is collected here.
            const groupNamesByKey = {};
            allRows.forEach(r => {
                Object.entries(r.customParamDisplayNames || {}).forEach(([k, d]) => {
                    if (d && !displayNameByKey[k]) displayNameByKey[k] = d;
                });
                Object.entries(r.customParamGroupNames || {}).forEach(([k, groups]) => {
                    if (!groupNamesByKey[k]) groupNamesByKey[k] = new Set();
                    (groups || []).forEach(g => { if (g) groupNamesByKey[k].add(g); });
                });
            });
            // Multiple group names for the same key are shown joined by
            // "||" in one cell, sorted for a stable/predictable label —
            // e.g. "IMOS System Link Parameters||Link Parameters".
            const groupLabelByKey = {};
            Object.keys(groupNamesByKey).forEach(k => {
                groupLabelByKey[k] = [...groupNamesByKey[k]].sort().join('||');
            });

            // Custom Parameters columns are dynamic — the union of every
            // key (simpleName or paramName) seen across all extracted
            // parts, CLUSTERED so keys sharing the exact same group label
            // sit next to each other instead of scattered across an
            // alphabetical-by-code order. Any label containing "Link
            // Parameters" (see LINK_GROUP_NAME_RE) comes first, right
            // after Suppress condition; every other label follows as its
            // own contiguous block (blocks ordered alphabetically by
            // label); keys with no group at all come last. Alphabetical by
            // key within each block.
            const customKeys = [...allKeys].sort((a, b) => {
                const la = groupLabelByKey[a] || '', lb = groupLabelByKey[b] || '';
                const rankOf = (label) => LINK_GROUP_NAME_RE.test(label) ? 0 : (label ? 1 : 2);
                const ra = rankOf(la), rb = rankOf(lb);
                if (ra !== rb) return ra - rb;
                if (la !== lb) return la < lb ? -1 : 1;
                return a < b ? -1 : (a > b ? 1 : 0);
            });

            // The code alone (e.g. "CZ") is hard to identify — three REAL
            // header rows, each its own spreadsheet row (not squeezed into
            // one cell): row 1 is the Group Name (e.g. "Link Parameters",
            // or "IMOS System Link Parameters||Link Parameters" when a key
            // belongs to more than one — same grouping the column order
            // above uses), row 2 is the Parameter Name (displayName, e.g.
            // "Material"), row 3 is the Reference name — the code, what
            // actually gets matched back on import (see the loader's
            // header-row detection and dynamicPartColumns). The fixed
            // columns (Product serial number, Width, ...) are only
            // populated on row 3 — blank on rows 1-2 — since neither a
            // Group Name nor a Parameter Name applies to them. A custom
            // key with no known group/displayName just falls back to
            // blank / the code itself.
            const blankFixedRow = PART_EXPORT_HEADERS.map(() => '');
            const groupHeaderRow = [...blankFixedRow, ...customKeys.map(k => groupLabelByKey[k] || '')];
            const displayHeaderRow = [...blankFixedRow, ...customKeys.map(k => displayNameByKey[k] || k)];
            const codeHeaderRow = [...PART_EXPORT_HEADERS, ...customKeys];

            downloadCsvReport(allRows, 'parts_extract', groupHeaderRow, r => [
                r.serial, r.childSerial, r.partName, r.partRefName,
                r.width, r.depth, r.height, r.positionX, r.positionY, r.positionZ,
                r.rotateX, r.rotateY, r.rotateZ, r.positionMethod, r.partHideCondition,
                r.partReplaceable, r.partQuotationRequired, r.partRemovable, r.partComponentRemovable,
                r.partStylePack, r.partBomOutput, r.partParameterEditable,
                r.partIgnoreInternalInterference, r.partResetAfterSuppression,
                r.partSuppressCondition,
                ...customKeys.map(k => r.customParams && r.customParams[k] !== undefined ? r.customParams[k] : '')
            ], [displayHeaderRow, codeHeaderRow]);
        });

        doorBtn.onclick = () => runExtraction(doorBtn, 'Extract Door Openings', extractDoorOpeningsFromEditorData, 'door opening(s)', (allRows) => {
            downloadCsvReport(allRows, 'door_openings_extract', DOOR_EXPORT_HEADERS, r => [
                r.serial, r.name, r.width, r.height, r.positionX, r.positionY, r.positionZ,
                r.rotateX, r.rotateY, r.rotateZ, r.hideCondition, r.positionMethod,
                r.doorOpeningType, r.adaptationUnit
            ]);
        });
    }

    // The panel's open/close animation uses `transition: all 0.2s`, which was
    // also easing every drag-driven transform update — that 0.2s catch-up lag
    // is what read as "slow dragging". Suspend the transition only while
    // actively dragging, restore it afterward so open/close stays animated.
    let xo = 0, yo = 0, ix, iy, dr = false;
    header.onmousedown = (e) => { ix = e.clientX - xo; iy = e.clientY - yo; dr = true; box.style.transition = 'none'; };
    document.onmouseup = () => { if (dr) box.style.transition = 'all 0.2s ease-in-out'; dr = false; };
    document.onmousemove = (e) => { if (dr) { xo = e.clientX - ix; yo = e.clientY - iy; box.style.transform = `translate3d(${xo}px,${yo}px,0)`; } };

})();
