// ==UserScript==
// @name         Global Parameter Batch Create (Kujiale/Coohom)
// @version      1.0.0
// @description  Batch-creates Global (library-level) parameters on Kujiale/Coohom's Global Parameters page from a CSV, one POST per row to the globalinput endpoint.
// @match        https://www.homworksstudio.com/pub/tool/cpm/editor/globalvariable*
// @match        https://prod-test-sg.coohom.com/pub/tool/cpm/editor/globalvariable*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// kujiale.com's own Global Parameters page uses a different base path than
// /pub/tool/cpm (the sibling script's kujiale.com @match is /vc/modeleditor/new,
// NOT /pub/tool/cpm/modeleditor/new) — no capture of that URL yet, so it's
// deliberately left out rather than guessed. Add a @match line above once
// you send its real URL.

(function () {
    'use strict';

    // =========================================================================
    // SECTION 0: CONFIG / STATE
    // =========================================================================
    // Everything in this file's request-body shape is copied from ONE
    // confirmed real "Copy as fetch" capture of the native "+Create Global
    // Parameter" dialog saving a Style/Options parameter (EPH148, "Edge
    // Profile Handle 148mm"). The valueType/paramTypeId matrix, value
    // wrapping, and Options/Expression conventions are the SAME system
    // already reverse-engineered against real per-model editorData in the
    // sibling script (batch-update-kujiale.user.js) — reused here rather
    // than re-guessed, since it's confirmed to be the same underlying type
    // system. Fields that only exist on THIS endpoint's body and were not
    // independently confirmed for any Parameter/Data type other than
    // Style+Options (required, tags, group.obsId, ignoreMode) are called
    // out at the point they're built below — verify against a real capture
    // before trusting an unusual combination.
    const THEME = {
        primary: '#0071e3', danger: '#ff453a', success: '#34c759',
        bg: 'rgba(255, 255, 255, 0.98)', border: 'rgba(0, 0, 0, 0.06)', textMain: '#1d1d1f'
    };

    let parsedRows = null; // [{rowNum, ...compiled fields}]
    let preValidationErrors = [];
    let lastRunErrors = [];
    let lastLibraryCapture = null; // { items: [...raw item objects...] }

    // =========================================================================
    // SECTION 0b: PASSIVE LIBRARY-LIST CAPTURE
    // =========================================================================
    // This page (see the No./Name/Reference name/... table) already lists
    // every existing global parameter in the library — it has to call some
    // endpoint to get that data, but that endpoint has never been captured
    // via "Copy as fetch", so its URL and exact response shape aren't
    // confirmed. Rather than guess a URL, hook fetch/XHR the same way the
    // sibling Sort Model script does and passively grab whatever response
    // the PAGE ITSELF requests — no URL assumption needed, only a shape
    // heuristic: an array (top-level, or under a common wrapper key) whose
    // items each have both paramName and displayName, since those are the
    // two field names confirmed real from the create endpoint's own body.
    // If the list endpoint uses different field names, the heuristic won't
    // match — the log/status area shows the sample keys of anything
    // captured so a mismatch is visible immediately, not silently wrong.
    function looksLikeParamArray(arr) {
        return Array.isArray(arr) && arr.length > 0 &&
            typeof arr[0] === 'object' && arr[0] !== null &&
            typeof arr[0].paramName === 'string' && typeof arr[0].displayName === 'string';
    }

    function findParamArray(json) {
        if (looksLikeParamArray(json)) return json;
        if (json && typeof json === 'object') {
            for (const key of ['data', 'list', 'items', 'result', 'results', 'globalInputs', 'content', 'records']) {
                if (looksLikeParamArray(json[key])) return json[key];
                if (json[key] && typeof json[key] === 'object' && looksLikeParamArray(json[key].list)) return json[key].list;
            }
        }
        return null;
    }

    function handleCapturedResponse(url, text) {
        let json;
        try { json = JSON.parse(text); } catch (e) { return; }
        const arr = findParamArray(json);
        if (!arr) return;
        lastLibraryCapture = { items: arr, sourceUrl: url };
        const sampleKeys = Object.keys(arr[0]).slice(0, 10).join(', ');
        setLibraryStatus(`Captured ${arr.length} existing parameter(s) from the page. Sample fields: ${sampleKeys}`);
    }

    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        return origFetch.apply(this, args).then((res) => {
            res.clone().text().then((text) => handleCapturedResponse(url, text)).catch(() => {});
            return res;
        });
    };
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__capturedUrl = url;
        return origXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
            if (this.__capturedUrl) handleCapturedResponse(this.__capturedUrl, this.responseText);
        });
        return origXhrSend.apply(this, args);
    };

    let libraryStatusEl = null;
    function setLibraryStatus(msg) {
        if (libraryStatusEl) libraryStatusEl.textContent = msg;
    }

    // =========================================================================
    // SECTION 1: TOAST
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
    // SECTION 2: UTILS — copied verbatim from batch-update-kujiale.user.js
    // (same valueType/paramTypeId system, independently confirmed there
    // against real editorData; reused here as-is, not re-derived).
    // =========================================================================
    const Utils = {
        normalizeExpr: (str) => {
            if (!str || typeof str !== "string") return str;
            const trimmed = str.trim();
            if (/^true$/i.test(trimmed)) return 'true';
            if (/^false$/i.test(trimmed)) return 'false';
            return trimmed;
        },
        wrapAssetLink: (val) => (val === null || val === undefined) ? val : String(val).trim(),
        wrapAssetValue: (val, pType) => {
            if (val === null || val === undefined || val === "") return val;
            const v = String(val).trim();
            if (v.startsWith("#") || v.startsWith("@")) return v;
            if (v.startsWith("{")) return v;
            if (pType === 'style' && /^[a-zA-Z0-9]{12,24}$/.test(v)) {
                return JSON.stringify({ obsBrandGoodId: v, versionId: 0 });
            }
            return v;
        },
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
        for (const p of patterns) {
            if (p.length < 3) continue;
            const idx = normHeaders.findIndex(h => h.includes(p));
            if (idx !== -1) return idx;
        }
        return -1;
    }

    const cell = (row, idx) => (idx !== -1 && row[idx] !== undefined) ? row[idx].trim() : '';

    // Same matrix as the sibling script (TYPE_MATRIX) — which Data types
    // are valid for each Parameter type.
    const TYPE_MATRIX = {
        float: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        integer: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        int: ['unlimited', 'options', 'interval', 'range', 'advanced formula', 'formula', 'fixed value'],
        text: ['unlimited', 'options', 'interval', 'advanced formula', 'formula', 'fixed value'],
        string: ['unlimited', 'options', 'interval', 'advanced formula', 'formula', 'fixed value'],
        boolean: ['unlimited', 'fixed value'],
        material: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value'],
        contour: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value'],
        style: ['unlimited', 'options', 'advanced formula', 'formula', 'fixed value']
    };
    const ASSET_TYPES = ['material', 'style', 'contour'];

    // Reverse of the pType/dType lowercasing above — used only to write a
    // clean, re-importable CSV back out (Export CSV), never for compiling
    // a request body.
    const PTYPE_LABELS = { float: 'Float', integer: 'Integer', int: 'Integer', text: 'Text', string: 'Text', boolean: 'Boolean', material: 'Material', contour: 'Contour', style: 'Style' };
    const DTYPE_LABELS = { unlimited: 'Unlimited', range: 'Range', options: 'Options', interval: 'Interval', formula: 'Formula', 'fixed value': 'Fixed Value', 'advanced formula': 'Advanced Formula' };
    const EXPORT_HEADERS = ['Display Name', 'Parameter Name', 'Parameter type', 'Data type', 'Value', 'Minimum', 'Maximum', 'Step size', 'Options', 'Expression', 'Hide condition', 'Description', 'Required', 'Tags', 'Group Id'];

    // Reverse of buildGlobalInputBody's own valueType/paramTypeId choices —
    // used only for decoding a captured existing-parameter item back into a
    // CSV row (Export Existing Parameters), never for compiling a request.
    const VALUETYPE_TO_PTYPE_LABEL = { int: 'Integer', string: 'Text', boolean: 'Boolean', float: 'Float', material: 'Material', contour: 'Contour', style: 'Style' };
    const DTYPE_LABEL_BY_PARAM_TYPE_ID = { 0: 'Unlimited', 1: 'Range', 2: 'Options', 3: 'Interval', 4: 'Advanced Formula', 5: 'Formula', 6: 'Fixed Value', 7: 'Advanced Formula' };

    // Mirrors Utils.wrapAssetValue in reverse — a captured Style value comes
    // back as {"obsBrandGoodId":...,"versionId":...}; unwrap to the bare id
    // so Export writes the same convention Import reads.
    function unwrapAssetVal(v) {
        if (v === null || v === undefined || v === '') return '';
        const s = String(v).trim();
        if (s.startsWith('#') || s.startsWith('@')) return s;
        if (s.startsWith('{')) {
            try { const o = JSON.parse(s); if (o && o.obsBrandGoodId) return o.obsBrandGoodId; } catch (e) { /* not JSON after all */ }
        }
        return s;
    }

    // Best-effort decode of one captured library item into an EXPORT_HEADERS
    // row. Field names (paramName/displayName/valueType/paramTypeId/value/
    // min/max/step/editorOptions/link/formula/ignore/description/required/
    // tags/group) are assumed to match buildGlobalInputBody's own body shape
    // one-for-one — reasonable since that shape IS confirmed real for this
    // endpoint's create direction, but the list/GET response was captured
    // passively (see SECTION 0b), not from a real "Copy as fetch", so this
    // mapping is unverified. Any field that comes back missing/differently
    // named just ends up blank in that column — check the exported CSV
    // against what the page's own table shows before trusting it at scale.
    function decodeLibraryItem(item) {
        const isAsset = ASSET_TYPES.includes(item.valueType);
        const paramTypeId = item.paramTypeId;
        const dTypeLabel = DTYPE_LABEL_BY_PARAM_TYPE_ID[paramTypeId] || 'Unlimited';
        const row = {
            displayName: item.displayName || '',
            paramName: item.paramName || '',
            pTypeLabel: VALUETYPE_TO_PTYPE_LABEL[item.valueType] || item.valueType || '',
            dTypeLabel,
            value: isAsset ? unwrapAssetVal(item.value) : (item.value != null ? item.value : ''),
            min: isAsset ? '' : (item.min != null ? item.min : ''),
            max: isAsset ? '' : (item.max != null ? item.max : ''),
            step: isAsset ? '' : (item.step != null ? item.step : ''),
            options: '',
            expression: '',
            hideCondition: (item.ignore && item.ignore !== 'false') ? item.ignore : '',
            description: item.description || '',
            required: item.required ? 'true' : 'false',
            tags: (Array.isArray(item.tags) && item.tags.length) ? JSON.stringify(item.tags) : '',
            groupId: (item.group && item.group.obsId) || ''
        };
        if (isAsset) {
            if (item.link) row.options = unwrapAssetVal(item.link);
            if (item.formula) row.expression = item.formula;
        } else {
            if (Array.isArray(item.editorOptions) && item.editorOptions.length) {
                row.options = JSON.stringify(item.editorOptions.map((o) => ({ name: o.name || '', value: o.value, ignore: o.ignore || '' })));
            }
            if (item.formula) row.expression = item.formula;
        }
        return row;
    }

    function computeParamTypeId(dataType) {
        switch (dataType) {
            case 'unlimited': return 0;
            case 'range': return 1;
            case 'options': return 2;
            case 'interval': return 3;
            case 'formula': return 5;
            case 'fixed value': return 6;
            // Advanced Formula on a global parameter has no confirmed
            // sample yet — Options-composite (7) vs Range-composite (4) is
            // guessed the same way the sibling script infers it (via a
            // "Composite type" column) until a real capture confirms it.
            case 'advanced formula': return 4;
            default: return 0;
        }
    }

    // =========================================================================
    // SECTION 3: CSV COLUMNS
    // Same header names as the sibling script's Add/Edit Params CSV, so a
    // user already familiar with that format can reuse it here.
    // =========================================================================
    function getColumnIndices(headers) {
        const n = headers.map(Utils.normHeader);
        return {
            displayName: findCol(n, 'displayname'),
            paramName: findCol(n, 'parametername'),
            paramType: findCol(n, 'parametertype'),
            dataType: findCol(n, 'datatype'),
            value: findCol(n, 'value'),
            min: findCol(n, 'minimum', 'min'),
            max: findCol(n, 'maximum', 'max'),
            step: findCol(n, 'stepsize', 'step'),
            options: findCol(n, 'options'),
            expression: findCol(n, 'expression'),
            hideCondition: findCol(n, 'hidecondition'),
            description: findCol(n, 'description'),
            // Fields unique to this endpoint — not present on the sibling
            // script's per-model CSV.
            required: findCol(n, 'required'),
            tags: findCol(n, 'tags'),
            groupId: findCol(n, 'groupid', 'group')
        };
    }

    function validateHeaders(idx) {
        const errs = [];
        if (idx.displayName === -1) errs.push("Missing required column 'Display Name'.");
        if (idx.paramName === -1) errs.push("Missing required column 'Parameter Name'.");
        if (idx.paramType === -1) errs.push("Missing required column 'Parameter type'.");
        if (idx.dataType === -1) errs.push("Missing required column 'Data type'.");
        return errs;
    }

    // =========================================================================
    // SECTION 4: ROW VALIDATION + COMPILE
    // =========================================================================
    function checkParens(s) {
        let depth = 0;
        for (const c of String(s)) {
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth < 0) return false; }
        }
        return depth === 0;
    }

    // Declared outside the row loop (rather than as a closure re-created on
    // every iteration) so it doesn't capture loop-scoped variables directly
    // — rowNum/refName come in as arguments instead, which is what a
    // function defined inside a loop body isn't safely allowed to close
    // over.
    function makeAddErr(rowNum, refName) {
        return (col, msg, fix) => preValidationErrors.push({ row: rowNum, refName, col, msg, fix });
    }

    function validateAndCompileRows(rows, idx) {
        preValidationErrors = [];
        const compiled = [];
        const seenNames = new Set();

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.length <= 1 && !row[0]) continue;
            const rowNum = i + 1;

            const displayName = cell(row, idx.displayName);
            const paramName = cell(row, idx.paramName);
            const pType = cell(row, idx.paramType).toLowerCase();
            const dType = cell(row, idx.dataType).toLowerCase();
            const value = cell(row, idx.value);
            const min = cell(row, idx.min);
            const max = cell(row, idx.max);
            const step = cell(row, idx.step);
            const optionsRaw = cell(row, idx.options);
            const expressionRaw = cell(row, idx.expression);
            const hideCondition = cell(row, idx.hideCondition);
            const description = cell(row, idx.description);
            const requiredRaw = cell(row, idx.required).toLowerCase();
            const tagsRaw = cell(row, idx.tags);
            const groupId = cell(row, idx.groupId);

            const addErr = makeAddErr(rowNum, paramName || displayName);

            if (!displayName) addErr('Display Name', 'Display Name is required.');
            if (!paramName) addErr('Parameter Name', 'Parameter Name is required.');
            if (paramName && !/^[A-Za-z][A-Za-z0-9_]*$/.test(paramName)) {
                addErr('Parameter Name', `'${paramName}' should be alphanumeric/underscore, starting with a letter — matches every real paramName seen (e.g. KBHT, EPH148).`);
            }
            if (paramName) {
                if (seenNames.has(paramName)) addErr('Parameter Name', `Duplicate Parameter Name '${paramName}' also appears earlier in this CSV.`);
                seenNames.add(paramName);
            }
            if (!TYPE_MATRIX[pType]) {
                addErr('Parameter type', `Unknown Parameter type '${cell(row, idx.paramType)}'.`, `Choose from: ${Object.keys(TYPE_MATRIX).join(', ')}.`);
                continue;
            }
            if (!TYPE_MATRIX[pType].includes(dType)) {
                addErr('Data type', `'${cell(row, idx.dataType)}' is not valid for Parameter type '${cell(row, idx.paramType)}'.`, `Allowed: ${TYPE_MATRIX[pType].join(', ')}.`);
                continue;
            }
            if (dType === 'advanced formula') {
                addErr('Data type', `'Advanced Formula' has no confirmed real sample for a Global Parameter yet — refusing to guess its shape. Use a different Data type, or capture a real "Copy as fetch" of one and send it over so this can be added safely.`);
                continue;
            }
            if (requiredRaw && requiredRaw !== 'true' && requiredRaw !== 'false') {
                addErr('Required', `Must be true or false, got '${cell(row, idx.required)}'.`);
            }
            if (tagsRaw) {
                try {
                    const parsed = JSON.parse(tagsRaw);
                    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
                } catch (e) {
                    addErr('Tags', `Not a valid JSON array, e.g. ["a","b"]: ${e.message}`);
                }
            }
            const isAsset = ASSET_TYPES.includes(pType);
            if (dType === 'options') {
                if (!optionsRaw) {
                    addErr('Options', isAsset ? "Options data type needs an asset id in the 'Options' column (the Link/Select side)." : "Options data type needs a JSON array in the 'Options' column, e.g. [{\"name\":\"A\",\"value\":\"1\"}].");
                } else if (!isAsset) {
                    try {
                        const parsed = JSON.parse(optionsRaw);
                        if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
                    } catch (e) {
                        addErr('Options', `Not a valid JSON array: ${e.message}`);
                    }
                }
            }
            if (dType === 'formula' && !expressionRaw) {
                addErr('Expression', "Formula data type needs an expression in the 'Expression' column.");
            }
            if (expressionRaw && expressionRaw.includes('#') && !checkParens(expressionRaw)) {
                addErr('Expression', 'Unbalanced parentheses.');
            }
            if (hideCondition && hideCondition.includes('#') && !checkParens(hideCondition)) {
                addErr('Hide condition', 'Unbalanced parentheses.');
            }

            const rowHasError = preValidationErrors.some(e => e.row === rowNum);
            if (rowHasError) continue;

            compiled.push({
                rowNum, displayName, paramName, pType, dType, value, min, max, step,
                optionsRaw, expressionRaw, hideCondition, description,
                required: requiredRaw === 'true',
                tags: tagsRaw ? JSON.parse(tagsRaw) : [],
                groupId
            });
        }
        return compiled;
    }

    // Builds the globalinput POST body. Confirmed field-for-field against
    // the one real capture (Style + Options); every other Parameter
    // type / Data type combination reuses the SAME wrapping rules already
    // confirmed in the sibling script for per-model inputs, since it's the
    // same underlying type system — but hasn't been independently
    // confirmed for THIS endpoint. Watch the first real run of a
    // combination you haven't used here before.
    function buildGlobalInputBody(r) {
        const isAsset = ASSET_TYPES.includes(r.pType);
        let valueType;
        if (r.pType === 'integer' || r.pType === 'int') valueType = 'int';
        else if (r.pType === 'text' || r.pType === 'string') valueType = 'string';
        else if (r.pType === 'boolean') valueType = 'boolean';
        else if (isAsset) valueType = r.pType;
        else valueType = 'float';

        const paramTypeId = computeParamTypeId(r.dType);

        const body = {
            displayName: r.displayName,
            paramName: r.paramName,
            required: r.required,
            valueType,
            paramTypeId,
            value: '',
            min: '', max: '', step: '',
            valueDisplayNames: [],
            editorOptions: [],
            editorRecommends: [],
            link: '',
            ignore: r.hideCondition ? Utils.normalizeExpr(r.hideCondition) : 'false',
            status: -1,
            formulaDisplayName: '',
            formula: '',
            valueFormat: 0,
            description: r.description || '',
            visible: true,
            valueRequired: true,
            tags: r.tags,
            // ignoreMode:1 is what the one confirmed sample sent — its
            // meaning wasn't independently determined, just reproduced.
            ignoreMode: 1
        };

        if (r.groupId) body.group = { obsId: r.groupId };

        if (r.value !== '') {
            body.value = isAsset ? Utils.wrapAssetValue(r.value, r.pType) : r.value;
        }

        if (isAsset) {
            if (r.dType === 'options' && r.optionsRaw) {
                body.link = Utils.wrapAssetLink(r.optionsRaw);
            }
            if (r.dType === 'formula' && r.expressionRaw) {
                body.formula = Utils.normalizeExpr(r.expressionRaw);
                body.formulaDisplayName = r.displayName;
            }
        } else {
            if (r.dType === 'options' && r.optionsRaw) {
                try {
                    const parsed = JSON.parse(r.optionsRaw);
                    body.editorOptions = parsed.map(o => ({ name: o.name || '', value: String(o.value), ignore: o.ignore || null, priority: null, extAttr: {} }));
                } catch (e) { /* already caught in validation */ }
            }
            if (r.dType === 'formula' && r.expressionRaw) {
                body.formula = Utils.normalizeExpr(r.expressionRaw);
                body.formulaDisplayName = r.displayName;
            }
            if (r.min !== '') body.min = Utils.normalizeExpr(r.min);
            if (r.max !== '') body.max = Utils.normalizeExpr(r.max);
            if (r.step !== '') body.step = r.step;
        }

        return body;
    }

    function currentObsLibraryId() {
        return new URLSearchParams(window.location.search).get('obsCustomLibraryId') || '';
    }

    async function createGlobalInput(body) {
        const origin = window.location.origin;
        const obsLibraryId = currentObsLibraryId();
        const url = `${origin}/editor/api/site/globalinput?obsLibraryId=${encodeURIComponent(obsLibraryId)}`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            mode: 'cors',
            headers: { accept: '*/*', 'content-type': 'application/json;charset=UTF-8', 'editor-locale': 'en_IN', 'x-qh-locale': 'en_IN', 'x-qh-site': 'coohom' },
            body: JSON.stringify(body)
        });
        const text = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON success body, ignore */ }
        if (json && json.success === false) throw new Error(json.message || json.msg || text.slice(0, 300));
        return json;
    }

    // =========================================================================
    // SECTION 5: UI
    // =========================================================================
    // Deferred until the DOM is ready (see the bottom of the file) — the
    // fetch/XHR capture hooks above run immediately at document-start so
    // they're in place before this page's own scripts make their first
    // requests, but building this panel needs document.body to exist.
    function buildUI() {
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
    header.innerHTML = '<b style="font-size:10px; color:#1d1d1f; letter-spacing:1px; text-transform:uppercase;">Global Param Batch <span style="color:#aaa; font-weight:400;">v1.0</span></b>';
    const closeBtn = document.createElement('div'); closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'cursor:pointer; font-size:12px; color:#ccc; font-weight:800;';
    closeBtn.onclick = () => { box.style.visibility = 'hidden'; box.style.opacity = '0'; };
    header.appendChild(closeBtn); box.appendChild(header);

    const body = document.createElement('div'); body.style.padding = '14px'; box.appendChild(body);

    const infoLine = document.createElement('div');
    infoLine.style.cssText = 'font-size:9px; color:#999; margin-bottom:10px; line-height:1.5;';
    infoLine.innerText = 'Creates NEW global parameters only (no edit/delete yet — no confirmed sample for those). Columns: Display Name, Parameter Name, Parameter type, Data type, Value, Minimum, Maximum, Step size, Options, Expression, Hide condition, Description, Required, Tags, Group Id. Export CSV re-exports the currently loaded rows.';
    body.appendChild(infoLine);

    // Existing-parameters export: this table's own list request is captured
    // passively (SECTION 0b) rather than called directly, since its exact
    // URL/shape was never confirmed via a real "Copy as fetch". If the page
    // hasn't made that request since this script loaded, reload the page
    // once so the hook is in place before the initial load fires.
    const libPanel = document.createElement('div');
    libPanel.style.cssText = 'padding:10px; background:#f9f9fb; border-radius:8px; border:1px solid #eee; margin-bottom:10px;';
    libPanel.innerHTML = '<div style="font-size:9px; font-weight:700; margin-bottom:6px; color:#0071e3;">Existing library parameters</div>';
    const libStatus = document.createElement('div');
    libStatus.style.cssText = 'font-size:9px; color:#999; margin-bottom:8px; line-height:1.4;';
    libStatus.textContent = 'Waiting to see the page load its parameter list — reload this page if nothing appears here.';
    libraryStatusEl = libStatus;
    libPanel.appendChild(libStatus);
    const exportExistingBtn = document.createElement('button');
    exportExistingBtn.style.cssText = 'width:100%; padding:8px; border:1px solid #0071e3; background:#fff; color:#0071e3; border-radius:6px; cursor:pointer; font-size:11px; font-weight:bold;';
    exportExistingBtn.innerText = '📥 Export Existing Parameters';
    exportExistingBtn.onclick = () => {
        if (!lastLibraryCapture || !lastLibraryCapture.items.length) {
            showNotification('❌ Nothing captured yet — reload the page and try again.', THEME.danger);
            return;
        }
        const rows = lastLibraryCapture.items.map(decodeLibraryItem);
        downloadCsvReport(rows, 'global_params_library_export', EXPORT_HEADERS, r => [
            r.displayName, r.paramName, r.pTypeLabel, r.dTypeLabel, r.value, r.min, r.max, r.step,
            r.options, r.expression, r.hideCondition, r.description, r.required,
            r.tags, r.groupId
        ]);
        showNotification(`✅ Exported ${rows.length} existing parameter(s). Verify a few rows against the page before trusting it at scale.`, THEME.success);
    };
    libPanel.appendChild(exportExistingBtn);
    body.appendChild(libPanel);

    const panel = document.createElement('div');
    panel.style.cssText = 'padding:10px; background:#f9f9fb; border-radius:8px; border:1px solid #eee;';
    panel.innerHTML = '<div id="status-label" style="font-size:9px; font-weight:700; margin-bottom:6px; color:#0071e3">Step 1: Import CSV</div><button id="load-btn" style="width:100%; padding:8px; border:1px dashed #ddd; background:#fff; border-radius:6px; cursor:pointer; font-size:11px; font-weight:bold; color:#555;">📂 Import CSV</button>';
    body.appendChild(panel);

    const logBox = document.createElement('div');
    logBox.innerHTML = '<div style="margin:10px 0 4px 0; font-size:9px; font-weight:bold; color:#aaa;">LOG VIEW: <span id="sync-stats" style="float:right; color:#0071e3;">IDLE</span></div><textarea id="log-text" readonly style="width:100%; height:60px; font-family:monospace; font-size:10px; border:1px solid #eee; border-radius:8px; padding:8px; resize:none; outline:none; background:#fff; color:#444; box-sizing:border-box;"></textarea>';
    body.appendChild(logBox);

    const progressLabel = document.createElement('div');
    progressLabel.id = 'progress-label';
    progressLabel.style.cssText = 'font-size:10px; color:#999; margin-top:4px;';
    body.appendChild(progressLabel);

    const runBtn = document.createElement('button');
    runBtn.id = 'main-run'; runBtn.innerText = 'Run';
    Object.assign(runBtn.style, { width: '100%', marginTop: '10px', padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: '#f0f0f2', color: '#ccc', fontWeight: '800', fontSize: '11px', cursor: 'not-allowed', pointerEvents: 'none' });
    body.appendChild(runBtn);

    const errorBtn = document.createElement('button');
    errorBtn.id = 'error-download';
    errorBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #ff4d4f; color:#ff4d4f; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    errorBtn.innerText = '📥 Download Format Errors';
    errorBtn.onclick = () => { downloadCsvReport(preValidationErrors, 'global_param_validation_errors', ['Row', 'Parameter Name', 'Column', 'Error', 'Suggested Fix'], e => [e.row, e.refName, e.col, e.msg, e.fix || '']); };
    body.appendChild(errorBtn);

    const runErrorBtn = document.createElement('button');
    runErrorBtn.id = 'run-error-download';
    runErrorBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #ff9f0a; color:#ff9f0a; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    runErrorBtn.innerText = '📥 Download Run Errors';
    runErrorBtn.onclick = () => { downloadCsvReport(lastRunErrors, 'global_param_run_errors', ['Parameter Name', 'Error'], e => [e.id, e.msg]); };
    body.appendChild(runErrorBtn);

    // Re-serializes the currently loaded CSV (parsedRows) back out in the
    // exact same column format Import CSV reads — an echo/audit of what's
    // staged to run, not a pull of parameters that already exist in the
    // library (that would need a list/GET endpoint this script has never
    // called, and nothing here guesses an endpoint shape without a real
    // "Copy as fetch" capture backing it).
    const exportBtn = document.createElement('button');
    exportBtn.id = 'export-csv';
    exportBtn.style.cssText = 'display:none; width:100%; margin-top:8px; padding:10px; border-radius:8px; border:1px solid #0071e3; color:#0071e3; background:#fff; font-size:11px; cursor:pointer; font-weight:bold;';
    exportBtn.innerText = '📤 Export CSV';
    exportBtn.onclick = () => {
        downloadCsvReport(parsedRows, 'global_params_export', EXPORT_HEADERS, r => [
            r.displayName, r.paramName, PTYPE_LABELS[r.pType] || r.pType, DTYPE_LABELS[r.dType] || r.dType,
            r.value, r.min, r.max, r.step, r.optionsRaw, r.expressionRaw, r.hideCondition, r.description,
            r.required ? 'true' : 'false', (r.tags && r.tags.length) ? JSON.stringify(r.tags) : '', r.groupId
        ]);
    };
    body.appendChild(exportBtn);

    document.body.appendChild(box);

    const trigger = document.createElement('button');
    trigger.innerText = 'Global Param Batch';
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

    function resetState() {
        parsedRows = null; preValidationErrors = []; lastRunErrors = [];
        document.getElementById('log-text').value = '';
        document.getElementById('error-download').style.display = 'none';
        document.getElementById('run-error-download').style.display = 'none';
        document.getElementById('export-csv').style.display = 'none';
        document.getElementById('progress-label').innerText = '';
        runBtn.disabled = true; runBtn.style.backgroundColor = '#f0f0f2'; runBtn.style.pointerEvents = 'none';
        document.getElementById('sync-stats').innerText = 'IDLE';
    }

    const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.csv'; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    document.getElementById('load-btn').onclick = () => { resetState(); fileInput.click(); };

    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (f) => {
            const rows = Utils.parseCSV(f.target.result);
            if (!rows || rows.length < 2) { showNotification('❌ Empty or invalid CSV.', THEME.danger); return; }
            const headers = rows[0];
            const idx = getColumnIndices(headers);

            const headerErrors = validateHeaders(idx);
            if (headerErrors.length > 0) {
                preValidationErrors = headerErrors.map(msg => ({ row: 'Header', refName: '', col: '', msg, fix: '' }));
                document.getElementById('log-text').value = `❌ ${headerErrors.join(' ')}`;
                document.getElementById('error-download').style.display = 'block';
                showNotification(`❌ ${headerErrors.length} header error(s).`, THEME.danger);
                return;
            }

            const compiled = validateAndCompileRows(rows, idx);
            if (preValidationErrors.length > 0) {
                document.getElementById('error-download').style.display = 'block';
            }
            if (compiled.length === 0) {
                document.getElementById('log-text').value = `❌ Every row had an error — nothing to run. Download report, fix, and re-import.`;
                showNotification(`❌ ${preValidationErrors.length} validation error(s) — no valid rows.`, THEME.danger);
                parsedRows = null;
                return;
            }
            parsedRows = compiled;
            const skippedNote = preValidationErrors.length > 0 ? ` ${preValidationErrors.length} row(s) skipped (errors).` : '';
            document.getElementById('log-text').value = `✅ ${compiled.length} parameter(s) ready to create.${skippedNote}`;
            runBtn.disabled = false; runBtn.style.backgroundColor = THEME.textMain; runBtn.style.color = '#fff'; runBtn.style.pointerEvents = 'auto'; runBtn.style.cursor = 'pointer';
            document.getElementById('export-csv').style.display = 'block';
            showNotification(`✅ ${compiled.length} parameter(s) ready. Press Run.`, THEME.success);
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    runBtn.onclick = async () => {
        if (!parsedRows || parsedRows.length === 0) return;
        runBtn.disabled = true; runBtn.style.pointerEvents = 'none';
        lastRunErrors = [];
        let done = 0, failed = 0;
        for (const r of parsedRows) {
            document.getElementById('progress-label').innerText = `Creating ${r.paramName} (${done + failed + 1}/${parsedRows.length})...`;
            try {
                const body = buildGlobalInputBody(r);
                await createGlobalInput(body);
                done++;
            } catch (e) {
                failed++;
                lastRunErrors.push({ id: r.paramName, msg: e.message });
            }
            document.getElementById('sync-stats').innerText = `${done + failed}/${parsedRows.length}`;
        }
        document.getElementById('progress-label').innerText = '';
        if (failed > 0) {
            document.getElementById('log-text').value = `⚠️ ${done} created, ${failed} failed. Download run errors for details.`;
            document.getElementById('run-error-download').style.display = 'block';
            showNotification(`⚠️ ${done} created, ${failed} failed.`, THEME.danger);
        } else {
            document.getElementById('log-text').value = `✅ All ${done} global parameter(s) created.`;
            showNotification(`✅ ${done} global parameter(s) created.`, THEME.success);
        }
        runBtn.disabled = false; runBtn.style.pointerEvents = 'auto';
    };
    } // end buildUI

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI);
    } else {
        buildUI();
    }
})();
