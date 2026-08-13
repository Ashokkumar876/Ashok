// ==UserScript==
// @name         Batch Custom Output Properties
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Batch process custom output properties on Coohom and Homworks Studio brandgoods detail pages
// @author       AI
// @match        https://www.coohom.com/pub/saas/brandgoods/detail?*
// @match        https://www.homworksstudio.com/pub/saas/brandgoods/detail?*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    GM_addStyle(`
        #batchBizPropModal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 8px;
            padding: 20px;
            z-index: 2147483647;
            width: 480px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 2px 12px rgb(0 0 0 / 0.4);
            font-family: Arial, "Microsoft YaHei", sans-serif;
        }
        #batchBizPropModal h3 {
            margin-top: 0;
            margin-bottom: 15px;
            font-weight: bold;
            font-size: 18px;
            text-align: center;
        }
        #batchBizPropModal label {
            display: block;
            margin-bottom: 6px;
            font-weight: 600;
        }
        #batchBizPropModal textarea,
        #batchBizPropModal select,
        #batchBizPropModal input[type=text] {
            width: 100%;
            padding: 6px 8px;
            margin-bottom: 12px;
            box-sizing: border-box;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 14px;
        }
        #batchBizPropModal .key-val-row {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
            align-items: center;
        }
        #batchBizPropModal .key-val-row select,
        #batchBizPropModal .key-val-row input[type=text] {
            flex: 1;
        }
        #batchBizPropModal .key-val-row button.removeKeyVal {
            flex-shrink: 0;
            background: #e74c3c;
            border: none;
            color: #fff;
            padding: 0 8px;
            height: 32px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        #batchBizPropModal .key-val-row button.removeKeyVal:hover {
            background: #c0392b;
        }
        #batchBizPropModal button.addKeyVal {
            margin-bottom: 12px;
            background: #1890ff;
            border: none;
            color: #fff;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        #batchBizPropModal button.addKeyVal:hover {
            background: #40a9ff;
        }
        #batchBizPropModal .btns {
            text-align: right;
            margin-top: 8px;
        }
        #batchBizPropModal button.btn {
            padding: 6px 16px;
            font-size: 15px;
            margin-left: 8px;
            border-radius: 5px;
            border: none;
            cursor: pointer;
        }
        #batchBizPropModal button.btn.confirm {
            background-color: #1890ff;
            color: white;
        }
        #batchBizPropModal button.btn.confirm:hover {
            background-color: #40a9ff;
        }
        #batchBizPropModal button.btn.cancel {
            background-color: #888;
            color: white;
        }
        #batchBizPropModal button.btn.cancel:hover {
            background-color: #555;
        }
        #batchBizPropModal .autoDeleteHint {
            font-size: 12px;
            color: #888;
            margin: -6px 0 12px;
        }
        #batchBizPropStatus {
            max-height: 150px;
            overflow-y: auto;
            font-size: 13px;
            line-height: 1.4em;
            border: 1px solid #ccc;
            padding: 8px;
            background: #f5f5f5;
            margin-top: 8px;
            white-space: pre-wrap;
            font-family: Consolas, "Courier New", monospace;
        }
    `);

    function createMainButton() {
        const btn = document.createElement('button');
        btn.textContent = 'Batch Custom Output Properties';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2147483647;
            padding: 8px 14px;
            background-color: #1890ff;
            border: 1px solid #0050b3;
            color: #fff;
            font-size: 14px;
            border-radius: 4px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        `;
        btn.title = "Open batch custom output properties panel";
        document.body.appendChild(btn);
        return btn;
    }

    function createModal(propertyOptions) {
        const modal = document.createElement('div');
        modal.id = 'batchBizPropModal';
        modal.innerHTML = `
            <h3>Batch Custom Output Properties</h3>
            <label for="obsBrandGoodIdsInput">Enter model obsBrandGoodIds (comma or newline separated):</label>
            <textarea id="obsBrandGoodIdsInput" rows="4" placeholder="e.g. 3FO3L3IDT0QR,3FO4JYKG1TSP or multi-line input"></textarea>

            <label>Select custom output property key-value pairs:</label>
            <div id="keyValuePairs"></div>
            <button class="addKeyVal" type="button">Add Key-Value Pair</button>

            <label for="operationSelect">Operation:</label>
            <select id="operationSelect">
                <option value="add">Add</option>
                <option value="overwrite">Overwrite</option>
                <option value="delete">Delete</option>
                <option value="autodelete">Delete only properties with a parse error (auto-detect per model)</option>
            </select>
            <div class="autoDeleteHint" id="autoDeleteHint" style="display:none;">
                For each model, this queries its current custom output properties, finds any whose value fails validation
                (e.g. VALUE_PARSE_ERROR), and deletes just those. Models with no errors are skipped and left untouched.
                Key-value pairs above are ignored in this mode.
            </div>

            <div class="btns">
                <button class="btn cancel" type="button">Cancel</button>
                <button class="btn confirm" type="button">Confirm</button>
            </div>

            <label>Status:</label>
            <pre id="batchBizPropStatus"></pre>
        `;

        function genKeyValRow(optionList) {
            const row = document.createElement('div');
            row.classList.add('key-val-row');

            const selectKey = document.createElement('select');
            selectKey.required = true;
            selectKey.style.minWidth = "140px";

            const emptyOption = document.createElement('option');
            emptyOption.value = '';
            emptyOption.textContent = '-- Select Key --';
            selectKey.appendChild(emptyOption);

            optionList.forEach(({ propertyKey, propertyName }) => {
                const op = document.createElement('option');
                op.value = propertyKey;
                op.textContent = `${propertyKey} (${propertyName})`;
                selectKey.appendChild(op);
            });

            const valInput = document.createElement('input');
            valInput.type = 'text';
            valInput.placeholder = 'Value';

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'removeKeyVal';
            delBtn.textContent = '×';
            delBtn.title = 'Remove this pair';
            delBtn.addEventListener('click', () => row.remove());

            row.appendChild(selectKey);
            row.appendChild(valInput);
            row.appendChild(delBtn);
            return row;
        }

        const keyValueContainer = modal.querySelector('#keyValuePairs');
        const addKeyValBtn = modal.querySelector('.addKeyVal');
        addKeyValBtn.onclick = () => {
            keyValueContainer.appendChild(genKeyValRow(propertyOptions));
        };

        keyValueContainer.appendChild(genKeyValRow(propertyOptions));

        // Auto-delete mode doesn't use manually picked keys/values — hide that section for it.
        const operationSelect = modal.querySelector('#operationSelect');
        const autoDeleteHint = modal.querySelector('#autoDeleteHint');
        operationSelect.addEventListener('change', () => {
            const isAutoDelete = operationSelect.value === 'autodelete';
            keyValueContainer.style.display = isAutoDelete ? 'none' : '';
            addKeyValBtn.style.display = isAutoDelete ? 'none' : '';
            autoDeleteHint.style.display = isAutoDelete ? '' : 'none';
        });

        return modal;
    }

    function showModal(propertyOptions) {
        return new Promise((resolve, reject) => {
            const modal = createModal(propertyOptions);
            document.body.appendChild(modal);

            const statusBox = modal.querySelector('#batchBizPropStatus');
            const obsIdsInput = modal.querySelector('#obsBrandGoodIdsInput');
            const operationSelect = modal.querySelector('#operationSelect');
            const keyValueContainer = modal.querySelector('#keyValuePairs');
            const cancelBtn = modal.querySelector('.cancel');
            const confirmBtn = modal.querySelector('.confirm');

            function closeModal() {
                modal.remove();
            }

            cancelBtn.onclick = () => {
                closeModal();
                reject(new Error('Operation cancelled'));
            };

            confirmBtn.onclick = async () => {
                const obsBrandGoodIdsRaw = obsIdsInput.value.trim();
                if (!obsBrandGoodIdsRaw) {
                    alert('Please enter obsBrandGoodIds');
                    return;
                }

                const obsBrandGoodIds = obsBrandGoodIdsRaw
                    .split(/[\n,]+/)
                    .map(s => s.trim())
                    .filter(Boolean);

                if (obsBrandGoodIds.length === 0) {
                    alert('Please enter valid obsBrandGoodIds');
                    return;
                }

                const operation = operationSelect.value;
                let keyValues = [];

                if (operation !== 'autodelete') {
                    const keySet = new Set();
                    for (const row of keyValueContainer.children) {
                        const selectKey = row.querySelector('select');
                        const valInput = row.querySelector('input[type=text]');
                        const key = selectKey.value.trim();
                        const value = valInput.value.trim();

                        if (!key) {
                            alert('Please select all keys');
                            return;
                        }

                        if (keySet.has(key)) {
                            alert(`Duplicate custom output property key: ${key}`);
                            return;
                        }

                        keySet.add(key);
                        keyValues.push({ key, value });
                    }

                    if (keyValues.length === 0) {
                        alert('Please add at least one key-value pair');
                        return;
                    }
                }

                confirmBtn.disabled = true;
                cancelBtn.disabled = true;

                try {
                    await processBatch(obsBrandGoodIds, keyValues, operation, statusBox);
                    alert('Batch operation completed');
                    closeModal();
                    resolve();
                } catch (e) {
                    alert('Error: ' + e.message);
                    confirmBtn.disabled = false;
                    cancelBtn.disabled = false;
                }
            };
        });
    }

    async function fetchJson(url, options = {}) {
        const res = await fetch(url, options);
        if (!res.ok) {
            throw new Error(`HTTP request failed: ${res.status} ${res.statusText}`);
        }
        return res.json();
    }

    // The query endpoint's per-property identifier has been observed as both `key` and `id`
    // depending on the environment/version — read whichever is present.
    function propId(bp) {
        return bp.key ?? bp.id ?? bp.propertyKey;
    }

    async function processBatch(obsBrandGoodIds, keyValues, operation, statusBox) {
        function appendStatus(msg) {
            statusBox.textContent += msg + '\n';
            statusBox.scrollTop = statusBox.scrollHeight;
        }

        async function queryBizProperties(obsBrandGoodId) {
            // Using a relative path to handle the active domain dynamically
            const url = `/gateway/editor/api/site/param/bizproperty/editordata/query?obsBrandGoodId=${encodeURIComponent(obsBrandGoodId)}`;
            const res = await fetchJson(url, {
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                },
                method: 'GET',
                mode: 'cors',
                credentials: 'include',
                referrer: location.href,
            });

            // Observed response is a plain array of property entries — no {c, d} wrapper.
            // Handle both shapes in case another environment/version does wrap it.
            if (Array.isArray(res)) return res;
            if (res && res.c !== undefined && res.c !== "0") {
                throw new Error(`query API failed: ${res.m || 'unknown error'}`);
            }
            return (res && Array.isArray(res.d)) ? res.d : [];
        }

        async function updateBizProperties(bodyData) {
            // Using a relative path to handle the active domain dynamically
            const url = '/gateway/editor/api/site/param/bizproperty/editordata/update';
            const res = await fetchJson(url, {
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json;charset=UTF-8',
                },
                method: 'POST',
                mode: 'cors',
                credentials: 'include',
                body: JSON.stringify(bodyData),
                referrer: location.href,
            });

            if (res.c !== "0") {
                throw new Error(`update API failed: ${res.m || 'unknown error'}`);
            }
            return res;
        }

        async function processOne(obsBrandGoodId) {
            appendStatus(`Processing model ID: ${obsBrandGoodId}`);

            if (operation === 'overwrite') {
                const body = {
                    obsBrandGoodId,
                    bizProperties: keyValues.map(({ key, value }) => ({ key, value }))
                };
                await updateBizProperties(body);
                appendStatus('  Overwrite success');
                return;
            }

            const existingBizProps = await queryBizProperties(obsBrandGoodId);

            if (operation === 'add') {
                const mergedMap = new Map();
                for (const bp of existingBizProps) {
                    mergedMap.set(propId(bp), { key: propId(bp), value: bp.value });
                }
                for (const { key, value } of keyValues) {
                    mergedMap.set(key, { key, value });
                }
                const mergedBizProperties = Array.from(mergedMap.values());
                await updateBizProperties({ obsBrandGoodId, bizProperties: mergedBizProperties });
                appendStatus('  Add success');
                return;
            }

            if (operation === 'delete') {
                const deleteKeys = new Set(keyValues.map(kv => kv.key));
                const filteredBizProps = existingBizProps.filter(bp => !deleteKeys.has(propId(bp)));
                await updateBizProperties({
                    obsBrandGoodId,
                    bizProperties: filteredBizProps.map(bp => ({ key: propId(bp), value: bp.value }))
                });
                appendStatus('  Delete success');
                return;
            }

            if (operation === 'autodelete') {
                const errored = existingBizProps.filter(bp => bp.error === true);
                if (errored.length === 0) {
                    appendStatus('  No parse errors found — skipped');
                    return;
                }
                const remaining = existingBizProps.filter(bp => bp.error !== true);
                await updateBizProperties({
                    obsBrandGoodId,
                    bizProperties: remaining.map(bp => ({ key: propId(bp), value: bp.value }))
                });
                const labels = errored.map(bp => {
                    const code = bp.validateResult && bp.validateResult.code;
                    return code ? `${propId(bp)} (${code})` : propId(bp);
                }).join(', ');
                appendStatus(`  Deleted ${errored.length} error propert${errored.length === 1 ? 'y' : 'ies'}: ${labels}`);
                return;
            }
        }

        const concurrencyLimit = 5;
        let index = 0;

        async function worker() {
            while (index < obsBrandGoodIds.length) {
                const currentIndex = index++;
                const id = obsBrandGoodIds[currentIndex];
                try {
                    await processOne(id);
                } catch (e) {
                    appendStatus(`【Error】Failed to process ${id}: ${e.message}`);
                }
            }
        }

        const workers = [];
        for (let i = 0; i < concurrencyLimit; i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    async function fetchBizPropertyOptions() {
        // Using a relative path to handle the active domain dynamically
        const url = "/gateway/editor/api/site/param/bizproperty/account/list?start=0&num=300";
        const res = await fetchJson(url, {
            headers: {
                "accept": "application/json, text/plain, */*",
                "content-type": "application/json",
            },
            method: "GET",
            mode: "cors",
            credentials: "include",
            referrer: location.href,
        });

        if (res.c !== "0") {
            throw new Error(`Failed to fetch custom output property options: ${res.m || 'unknown error'}`);
        }
        return res.d.result || [];
    }

    async function main() {
        const btn = createMainButton();
        btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = 'Loading...';
            try {
                const propertyOptions = await fetchBizPropertyOptions();
                await showModal(propertyOptions);
            } catch (e) {
                alert('Error: ' + e.message);
                console.error(e);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Batch Custom Output Properties';
            }
        };
    }

    window.addEventListener('load', main);
})();
