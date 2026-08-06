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
        // "Edit" isn't implemented — there's no confirmed way to re-identify
        // an already-added part instance from a CSV row (refName is
        // optional, so it can't serve as a key), only to add new ones.
        PART_EDIT: { id: 'PART_EDIT', label: 'Add Parts', color: THEME.success, icon: '🧩', implemented: true },
        PART_DEL: { id: 'PART_DEL', label: 'Delete Parts', color: THEME.warning, icon: '🗑', implemented: false }
    };

    let currentTask = null;
    let parsedData = null; // Map<serial, row[]> (row = single object for QUOTE)
    let preValidationErrors = [];
    let lastRunErrors = [];

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
        normalizeExpr: (str) => {
            if (!str || typeof str !== "string") return str;
            return str.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||').trim();
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
            partRefName: findCol(n, 'referencename')
        };
    }

    const cell = (row, idx) => (idx !== -1 && row[idx] !== undefined) ? row[idx].trim() : '';

    // Parameter type -> allowed Data types (derived from the verified schema table).
    const TYPE_MATRIX = {
        float: ['options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        integer: ['options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        int: ['options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        float2: ['unlimited', 'advanced formula', 'formula'],
        // Text shares the same set as Float/Integer, minus Range only —
        // Interval IS allowed for Text (confirmed; not a guess).
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

    function checkParens(str) {
        const open = (str.match(/\(/g) || []).length;
        const close = (str.match(/\)/g) || []).length;
        return open === close;
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
    errorBtn.onclick = () => { downloadCsvReport(preValidationErrors, 'csv_validation_errors', ['Row', 'Model ID', 'Reference Name', 'Column', 'Error', 'Suggested Fix'], e => [e.row, e.serial, e.refName, e.col, e.msg, e.fix || '']); };
    body.appendChild(errorBtn);

    const runErrorBtn = document.createElement('button');
    runErrorBtn.id = 'run-error-download';
    runErrorBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #ff9f0a; color:#ff9f0a; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    runErrorBtn.innerText = '📥 Download Run Errors';
    runErrorBtn.onclick = () => { downloadCsvReport(lastRunErrors, 'batch_run_errors', ['Model ID', 'Error'], e => [e.id, e.msg]); };
    body.appendChild(runErrorBtn);

    document.body.appendChild(box);

    const trigger = document.createElement('button');
    trigger.innerText = 'Batch Update';
    Object.assign(trigger.style, { position: 'fixed', top: '10px', left: '350px', zIndex: '99999', padding: '6px 12px', backgroundColor: '#1d1d1f', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' });
    trigger.onclick = () => { box.style.visibility = (box.style.visibility === 'visible' ? 'hidden' : 'visible'); box.style.opacity = (box.style.opacity === '1' ? '0' : '1'); };
    document.body.appendChild(trigger);

    function downloadCsvReport(items, filenamePrefix, headerRow, rowMapper) {
        if (!items || items.length === 0) return;
        let csv = "﻿" + headerRow.join(',') + "\n";
        items.forEach(item => {
            const vals = rowMapper(item).map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`);
            csv += vals.join(',') + "\n";
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
        reader.onload = (f) => {
            const rows = Utils.parseCSV(f.target.result);
            if (!rows || rows.length < 2) { showNotification('❌ Empty or invalid CSV.', THEME.danger); return; }
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
            }

            if (preValidationErrors.length === 0) {
                if (currentTask.id === 'QUOTE') validateQuoteRows(rows, idx);
                else if (currentTask.id === 'PARAM_EDIT') validateParamEditRows(rows, idx);
                else if (currentTask.id === 'PARAM_DEL') validateParamDelRows(rows, idx);
                else if (currentTask.id === 'PART_EDIT') validatePartEditRows(rows, idx);
            }

            if (preValidationErrors.length > 0) {
                document.getElementById('log-text').value = `❌ Found ${preValidationErrors.length} error(s). Download report, fix, and re-import.`;
                document.getElementById('error-download').style.display = 'block';
                showNotification(`❌ ${preValidationErrors.length} validation error(s) found.`, THEME.danger);
                parsedData = null;
            } else {
                parsedData = buildDataMap(currentTask.id, rows, idx);
                document.getElementById('log-text').value = `✅ ${parsedData.size} model(s) validated. Press Run.`;
                document.getElementById('error-download').style.display = 'none';
                runBtn.disabled = false; runBtn.style.backgroundColor = THEME.textMain; runBtn.style.color = '#fff'; runBtn.style.pointerEvents = 'auto'; runBtn.style.cursor = 'pointer';
                showNotification(`✅ ${parsedData.size} model(s) ready to run.`, THEME.success);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

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
                if (v.includes('#')) {
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
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;
            const serial = cell(row, idx.serial);
            const childSerial = cell(row, idx.childSerial);
            const partName = cell(row, idx.partName);
            if (!serial) addErr(rowNum, 'Empty', partName, 'Product serial number', 'Model serial ID is empty.');
            if (!childSerial) addErr(rowNum, serial, partName, 'Child Serial Number', 'Child Serial Number is required.');
            if (!partName) addErr(rowNum, serial, '', 'Part Name', 'Part Name is required.');
            // Reference name is optional (confirmed) — no check.

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
                                if (!o || o.name === undefined || o.value === undefined) throw new Error(`entry ${oi} missing name/value`);
                            });
                        } catch (e) {
                            addErr(rowNum, serial, refName, 'Options', `Options is not a valid JSON array of {name,value}: ${e.message}`);
                            optionsParsed = null;
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

    function buildDataMap(taskId, rows, idx) {
        const map = new Map();
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]; if (row.length <= 1 && !row[0]) continue;
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
                map.get(serial).push({ refName: cell(row, idx.paramName) });
                continue;
            }

            if (taskId === 'PART_EDIT') {
                map.get(serial).push({
                    childSerial: cell(row, idx.childSerial),
                    partName: cell(row, idx.partName),
                    partRefName: cell(row, idx.partRefName)
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
    function buildOptionEntries(parsedArr) {
        return parsedArr.map(o => ({
            name: o.name != null ? String(o.name) : '',
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
            } else if (dType !== 'formula' && dType !== 'options') {
                input.link = null; input.linkForm = 0; input.formula = null; input.formulaForm = 0;
                if (input.extAttr) delete input.extAttr.formulaLimit;
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

    function selfHealReferencedVars(ed) {
        if (!ed.inputs) return;
        const matches = JSON.stringify(ed).match(/#[a-zA-Z0-9_]+/g) || [];
        const referenced = new Set(matches.map(m => m.slice(1)));
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

    // Returns an error string on failure, or undefined on success — same
    // convention as compileParamEditRow (the import lookup is async and can
    // genuinely fail). Add-only: there's no confirmed way to re-identify an
    // already-added part from a CSV row (refName is optional per the
    // confirmed schema, so it can't serve as a lookup key), so every row
    // pushes a new modelInstances entry.
    async function compilePartEditRow(ed, row) {
        // Reproduced on a real run: re-importing a CSV that includes a part
        // already added to this model (from an earlier run, or a repeated
        // row in this same CSV) silently pushed a SECOND modelInstances
        // entry with the same refName — server rejected the save as
        // "instanceId重复或为空; 部件引用名重复". Checked up front (cheap,
        // no network call) against both pre-existing parts AND ones already
        // pushed earlier in this same run.
        if (row.partRefName && (ed.modelInstances || []).some(mi => mi.refName === row.partRefName)) {
            return `Reference name '${row.partRefName}' already exists on a part in this model — remove this row if it's already added, or use a different Reference name.`;
        }

        const parentHasCZ = (ed.inputs || []).some(i => i.paramName === 'CZ');
        let def;
        try {
            def = await fetchImportModelInstance(row.childSerial, parentHasCZ);
        } catch (e) {
            return `Part import lookup failed for Child Serial Number '${row.childSerial}': ${e.message}`;
        }
        if (!def) return `Part '${row.childSerial}' not found (import endpoint returned no editorModelInstances).`;

        const instance = _.cloneDeep(def);
        instance.uniqueId = generateUniqueId();
        instance.instanceId = nextInstanceId(ed);
        if (row.partName) instance.name = row.partName;
        // Reference name is optional per row (confirmed) — but leaving it
        // as the import response's literal null broke on a real run when
        // several blank-refName rows landed in the SAME save: server
        // rejected it as "part reference name duplicate" (多 null 视为重复).
        // Pre-existing null-refName parts in a model are fine — those were
        // each saved one at a time — but multiple simultaneous nulls in one
        // save batch are not. Fall back to a name-derived, batch-unique
        // value instead of leaving it null.
        instance.refName = row.partRefName || deriveFallbackPartRefName(row.partName, instance.instanceId);

        if (!ed.modelInstances) ed.modelInstances = [];
        ed.modelInstances.push(instance);
    }

    // Alphanumeric/underscore only, matching the paramName convention used
    // elsewhere — suffixed with instanceId (already guaranteed unique per
    // model) so two rows with the same Part Name can't collide either.
    function deriveFallbackPartRefName(partName, instanceId) {
        const base = String(partName || 'PART').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) || 'PART';
        return `${base}_${instanceId}`;
    }

    function checkDeletionDependencies(ed, rows) {
        const deletedNames = new Set(rows.map(r => r.refName));
        const inputs = ed.inputs || [];
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
                if (field) return `Cannot delete '${r.refName}' — referenced in the ${field} of '${inp.paramName}'.`;
            }
        }
        return null;
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

    async function processModel(modelId, data) {
        const origin = window.location.origin;
        const tool = currentToolType();
        const hdrs = { "accept": "*/*", "editor-locale": "zh_CN" };

        if (currentTask.id === 'PART_DEL') {
            return { ok: false, msg: 'Parts deletion not implemented yet.' };
        }

        let resp;
        try {
            resp = await fetch(`${origin}/editor/api/site/editordata?obsbrandgoodid=${modelId}&tooltype=${tool}`, { headers: hdrs, credentials: 'include' });
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
            const depErr = checkDeletionDependencies(ed, data);
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
        } else if (currentTask.id === 'PART_EDIT') {
            for (const row of data) {
                const rowErr = await compilePartEditRow(ed, row);
                if (rowErr) return { ok: false, msg: rowErr };
            }
        }

        if (_.isEqual(original, ed)) return { ok: true };

        const bodyStr = JSON.stringify(ed);
        const validation = await callValidateApi(bodyStr, ed.inputs);
        if (!validation.ok) return { ok: false, msg: validation.msg };

        let save;
        try {
            save = await fetch(`${origin}/editor/api/site/editordata`, {
                method: 'POST', credentials: 'include',
                headers: { "content-type": "text/plain;utf-8", ...hdrs },
                body: JSON.stringify({ editorData: ed, paramModelInfo: json.paramModelInfo })
            });
        } catch (e) {
            return { ok: false, msg: `POST network error: ${e.message}` };
        }
        if (!save.ok) return { ok: false, msg: `POST failed, status ${save.status}` };

        try {
            await fetch(`${origin}/editortask/editordata/review`, {
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
            const resp = await fetch(`${window.location.origin}/editor/api/site/3d?prodcatid=${CONFIG.PRODCATID}&compress=false`, {
                method: 'POST', credentials: 'include',
                headers: { "accept": "*/*", "content-type": "text/plain;utf-8", "editor-locale": "zh_CN" },
                body: bodyStr
            });
            const text = await resp.text();
            let data;
            try { data = JSON.parse(text); } catch (e) { return { ok: false, msg: `Validation endpoint returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}` }; }
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
        Object.assign(d.style, { position: 'fixed', top: '100px', left: '700px', width: '450px', height: '550px', background: '#fff', zIndex: '100001', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', border: '1px solid #ddd', overflow: 'hidden' });
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

    // The panel's open/close animation uses `transition: all 0.2s`, which was
    // also easing every drag-driven transform update — that 0.2s catch-up lag
    // is what read as "slow dragging". Suspend the transition only while
    // actively dragging, restore it afterward so open/close stays animated.
    let xo = 0, yo = 0, ix, iy, dr = false;
    header.onmousedown = (e) => { ix = e.clientX - xo; iy = e.clientY - yo; dr = true; box.style.transition = 'none'; };
    document.onmouseup = () => { if (dr) box.style.transition = 'all 0.2s ease-in-out'; dr = false; };
    document.onmousemove = (e) => { if (dr) { xo = e.clientX - ix; yo = e.clientY - iy; box.style.transform = `translate3d(${xo}px,${yo}px,0)`; } };

})();
