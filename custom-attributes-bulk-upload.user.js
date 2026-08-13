// ==UserScript==
// @name         Custom Attributes Bulk Upload homworksstudio
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Upload a CSV of Product IDs + attribute values and batch-apply them via the Custom Attribute save API
// @match        https://www.homworksstudio.com/pub/saas/brandgoods/*
// @match        https://homworksstudio.com/pub/saas/brandgoods/*
// @match        https://prod-test-sg.homworksstudio.com/pub/saas/brandgoods/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SAVE_URL = 'https://www.homworksstudio.com/gateway/dcscms/api/custom/brandgood/attribute';
    const DELAY_MS = 300; // pause between requests so we don't hammer the server
    const DELETE_MARKER = 'DELETE'; // put this word in a cell (instead of a value) to delete that attribute

    function getListUrl(productId) {
        return `${SAVE_URL}?start=0&num=100&obsBgId=${encodeURIComponent(productId)}`;
    }

    // Known attribute reference-name -> attributeId mapping.
    // Add more rows here if you have other custom attributes to support —
    // just find their attributeId the same way (Network tab -> save request -> Payload).
    const ATTRIBUTE_MAP = {
        'MTY': 19040,
        'MFC': 19045,
        'MTH': 19046,
        'MSC': 19047,
        'MGC': 19048,
        'EBAC': 19062,
        'EBIC': 19063,
        'EBBN': 19064,
        'EBDC': 19065,
        'EB_22_0p8': 19066,
        'EB_22_1p0': 19067,
        'EB_22_2p0': 19068,
        'EB_23_1p0': 19069,
        'EB_23_1p3': 19070,
        'EB_25_1p3': 19071,
        'EB_30_0p8': 19072,
        'EB_30_2p0': 19073,
        'EB_45_0p8': 19074,
        'EB_45_2p0': 19075,
    };

    // ===== Minimal CSV parser (handles quoted commas) =====
    function parseCSV(text) {
        const rows = [];
        let row = [], field = '', inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else field += c;
            } else {
                if (c === '"') inQuotes = true;
                else if (c === ',') { row.push(field); field = ''; }
                else if (c === '\n' || c === '\r') {
                    if (c === '\r' && text[i + 1] === '\n') i++;
                    row.push(field); field = '';
                    if (row.length > 1 || row[0] !== '') rows.push(row);
                    row = [];
                } else field += c;
            }
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows;
    }

    function buildJobs(rows) {
        if (rows.length < 2) return { jobs: [], warnings: ['CSV has no data rows.'] };
        const header = rows[0].map(h => h.trim());
        const idColIdx = header.findIndex(h => h.toLowerCase().replace(/\s/g, '') === 'productid'
            || h.toLowerCase().replace(/\s/g, '') === 'obsbgid'
            || h.toLowerCase().replace(/\s/g, '') === 'id');
        if (idColIdx === -1) {
            return { jobs: [], warnings: ['No "ProductID" column found in the first row. First column header should be ProductID (or obsBgId).'] };
        }

        const nameColIdx = header.findIndex(h => ['materialname', 'material', 'name', 'productname']
            .includes(h.toLowerCase().replace(/\s/g, '')));

        const attrCols = [];
        const warnings = [];
        header.forEach((h, idx) => {
            if (idx === idColIdx || idx === nameColIdx) return;
            const key = h.trim();
            if (!key) return;
            if (ATTRIBUTE_MAP[key] != null) {
                attrCols.push({ idx, attributeId: ATTRIBUTE_MAP[key], name: key });
            } else {
                warnings.push(`Column "${key}" doesn't match a known attribute reference name — it will be skipped.`);
            }
        });

        const jobs = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const productId = (row[idColIdx] || '').trim();
            if (!productId) continue;
            const materialName = nameColIdx !== -1 ? (row[nameColIdx] || '').trim() : '';
            const setAttrs = [];
            const deleteAttrIds = [];
            attrCols.forEach(col => {
                const val = (row[col.idx] || '').trim();
                if (val.toUpperCase() === DELETE_MARKER) {
                    deleteAttrIds.push(col.attributeId);
                } else {
                    // Blank cells are now sent as an empty value ("") rather than being skipped.
                    setAttrs.push({ attributeId: col.attributeId, attributeValue: val });
                }
            });
            if (setAttrs.length > 0 || deleteAttrIds.length > 0) {
                jobs.push({ productId, materialName, setAttrs, deleteAttrIds });
            }
        }
        return { jobs, warnings };
    }

    async function runJobs(jobs, onProgress) {
        const results = [];
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            const notes = [];
            let overallOk = true;

            // --- Handle sets (add/update) ---
            if (job.setAttrs.length > 0) {
                try {
                    const res = await fetch(SAVE_URL, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ obsBgIds: [job.productId], attributes: job.setAttrs }),
                    });
                    if (!res.ok) {
                        overallOk = false;
                        notes.push(`set failed: HTTP ${res.status}`);
                    } else {
                        const data = await res.json().catch(() => null);
                        if (data && data.success === false) {
                            overallOk = false;
                            notes.push(`set failed: ${data.message || JSON.stringify(data)}`);
                        } else {
                            notes.push(`set ${job.setAttrs.length}`);
                        }
                    }
                } catch (e) {
                    overallOk = false;
                    notes.push(`set failed: ${e}`);
                }
            }

            // --- Handle deletes ---
            if (job.deleteAttrIds.length > 0) {
                try {
                    const listRes = await fetch(getListUrl(job.productId), { credentials: 'include' });
                    const listData = await listRes.json().catch(() => null);
                    const current = (listData && listData.d && listData.d.result) || [];
                    const toDelete = job.deleteAttrIds
                        .map(attrId => current.find(a => a.attributeId === attrId))
                        .filter(Boolean);
                    const missing = job.deleteAttrIds.length - toDelete.length;
                    if (missing > 0) notes.push(`${missing} delete target(s) not currently set, skipped`);

                    if (toDelete.length > 0) {
                        const delRes = await fetch(SAVE_URL, {
                            method: 'DELETE',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ obsBgIds: [job.productId], attributes: toDelete }),
                        });
                        if (!delRes.ok) {
                            overallOk = false;
                            notes.push(`delete failed: HTTP ${delRes.status}`);
                        } else {
                            const delData = await delRes.json().catch(() => null);
                            if (delData && delData.success === false) {
                                overallOk = false;
                                notes.push(`delete failed: ${delData.message || JSON.stringify(delData)}`);
                            } else {
                                notes.push(`deleted ${toDelete.length}`);
                            }
                        }
                    }
                } catch (e) {
                    overallOk = false;
                    notes.push(`delete failed: ${e}`);
                }
            }

            results.push({
                productId: job.productId,
                materialName: job.materialName,
                attrCount: job.setAttrs.length + job.deleteAttrIds.length,
                status: overallOk ? 'OK' : 'FAILED',
                message: notes.join('; '),
            });
            onProgress(i + 1, jobs.length, results[results.length - 1]);
            if (i < jobs.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
        }
        return results;
    }

    // ===== UI =====
    function createPanel() {
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed', top: '10px', right: '20px', width: '320px', maxHeight: '80vh',
            display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #d9d9d9',
            borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.18)', zIndex: 999999,
            fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '13px', overflow: 'hidden',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            background: '#1890ff', color: '#fff', padding: '8px 10px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between', cursor: 'move', userSelect: 'none',
        });
        header.innerHTML = '<span style="font-weight:bold">🧩 Batch Attribute Updater</span>';
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cursor = 'pointer';
        closeBtn.onclick = () => { panel.style.display = 'none'; };
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        Object.assign(body.style, { padding: '10px', overflowY: 'auto', flex: '1' });
        body.innerHTML = `
            <div style="margin-bottom:8px; color:#666; line-height:1.5;">
                CSV format: first column header <b>ProductID</b>, an optional <b>MaterialName</b> column
                (shown in the log for readability, not sent to homworksstudio), and other columns headed by
                attribute reference names (${Object.keys(ATTRIBUTE_MAP).join(', ')}).<br>
                • Every attribute column you include is applied to every row.<br>
                • Leave a cell blank to set that attribute to an empty value.<br>
                • Put text in the cell to set it to that value.<br>
                • Type <b>DELETE</b> in the cell to remove that attribute from that product entirely.
            </div>
            <input type="file" id="__batchAttrFile" accept=".csv" style="margin-bottom:8px; width:100%;" />
            <div id="__batchAttrSummary" style="color:#888; margin-bottom:8px;"></div>
            <button id="__batchAttrRun" disabled style="width:100%; padding:8px; background:#52c41a; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">▶ Run Batch Update</button>
            <div id="__batchAttrLog" style="margin-top:10px; font-size:12px; max-height:280px; overflow-y:auto;"></div>
        `;
        panel.appendChild(body);
        document.body.appendChild(panel);
        makeDraggable(panel, header);

        let parsedJobs = [];

        const fileInput = body.querySelector('#__batchAttrFile');
        const summary = body.querySelector('#__batchAttrSummary');
        const runBtn = body.querySelector('#__batchAttrRun');
        const log = body.querySelector('#__batchAttrLog');

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const rows = parseCSV(String(reader.result));
                const { jobs, warnings } = buildJobs(rows);
                parsedJobs = jobs;
                let html = `Parsed <b>${jobs.length}</b> product row(s) to update.`;
                if (warnings.length) {
                    html += '<br>' + warnings.map(w => `⚠️ ${w}`).join('<br>');
                }
                summary.innerHTML = html;
                runBtn.disabled = jobs.length === 0;
            };
            reader.readAsText(file);
        });

        runBtn.addEventListener('click', async () => {
            if (parsedJobs.length === 0) return;
            runBtn.disabled = true;
            runBtn.textContent = 'Running...';
            log.innerHTML = '';
            const results = await runJobs(parsedJobs, (done, total, last) => {
                runBtn.textContent = `Running... (${done}/${total})`;
                const line = document.createElement('div');
                line.style.padding = '3px 0';
                line.style.borderBottom = '1px solid #f5f5f5';
                line.style.color = last.status === 'OK' ? '#389e0d' : '#cf1322';
                const label = last.materialName ? `${last.materialName} (${last.productId})` : last.productId;
                line.textContent = `${last.status === 'OK' ? '✓' : '✗'} ${label} (${last.attrCount} attr) ${last.message || ''}`;
                log.appendChild(line);
                log.scrollTop = log.scrollHeight;
            });
            const okCount = results.filter(r => r.status === 'OK').length;
            runBtn.textContent = `▶ Run Batch Update`;
            runBtn.disabled = false;
            summary.innerHTML = `Done: ${okCount}/${results.length} succeeded.`;

            // Offer a downloadable log
            const csvLines = ['materialName,productId,attrCount,status,message',
                ...results.map(r => `"${(r.materialName || '').replace(/"/g, '""')}","${r.productId}",${r.attrCount},${r.status},"${(r.message || '').replace(/"/g, '""')}"`)];
            const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'batch_attribute_results.csv';
            a.textContent = '⬇ Download results log';
            Object.assign(a.style, { display: 'block', marginTop: '8px', color: '#1890ff' });
            log.parentElement.insertBefore(a, log);
        });
    }

    function makeDraggable(panel, handle) {
        let dragging = false, offsetX = 0, offsetY = 0;
        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
})();
