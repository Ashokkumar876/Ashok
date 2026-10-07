// ==UserScript==
// @name         Homworks Studio - Professional Auto Update v13
// @namespace    http://tampermonkey.net/
// @version      13.0
// @description  One-click Auto Update using native Coohom controls. Self-healing: waits for real list reloads, re-selects all, confirms dialogs, and automatically refreshes / reloads the page when a batch stalls — no manual refresh needed.
// @match        https://www.homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @match        https://homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /*
     * ============================================================
     * HOMWORKS STUDIO - PROFESSIONAL AUTO UPDATE v13
     * ============================================================
     *
     * One click → runs until 0 models remain. No manual refresh.
     *
     * Changes vs v12:
     * - Refresh List now waits for the page's own network request to
     *   finish (not just "count looks the same"), so the next batch is
     *   never selected from a stale list.
     * - Select All always ends with ALL models selected (fixes a stale
     *   partial selection being reused).
     * - Confirmation dialogs after Update Part (OK / Confirm / Yes ...)
     *   are clicked automatically.
     * - Self-healing:
     *     stall (no progress in STALL_MS)  → Refresh List + redo batch
     *     repeated stalls / errors         → automatic full page reload,
     *                                         the run resumes by itself
     *     too many reloads with no progress → stop with a clear message
     *       (prevents an endless reload loop)
     * - Backend mode: if the UI shows more models than the backend
     *   reports, the list is treated as stale and refreshed again.
     */

    const CFG = {
        UPDATE_SETTLE_MS: 1800,
        REFRESH_CLICK_DELAY_MS: 250,
        REFRESH_TIMEOUT_MS: 15000,
        NET_IDLE_MS: 600,
        BACKEND_POLL_MS: 1000,
        UI_POLL_MS: 3000,
        STALL_MS: 45000,             // no decrease for this long = stalled batch
        FINAL_VERIFY_DELAY_MS: 1800,
        FINAL_VERIFY_PASSES: 2,
        UI_STABLE_MS: 900,
        SELECT_TIMEOUT_MS: 8000,
        PAGE_READY_MS: 700,
        PAGE_READABLE_TIMEOUT_MS: 20000,
        LIBRARY_ID_WAIT_MS: 6000,
        BEFORE_UPDATE_MS: 250,
        CONFIRM_WAIT_MS: 2500,
        RETRY_MS: 2500,
        CLOCK_MS: 1000,

        MAX_SOFT_RECOVERIES: 2,      // stalls before a full page reload
        MAX_CONSECUTIVE_ERRORS: 3,   // errors before a full page reload
        MAX_RELOADS_NO_PROGRESS: 5,  // reloads in a row without progress → stop
        MAX_STALE_REFRESHES: 2,      // extra Refresh List when UI is stale

        RUN_KEY: '__HW_PRO_AUTO_V13_RUNNING__',
        STATS_KEY: '__HW_PRO_AUTO_V13_STATS__',
        LIB_KEY: '__HW_PRO_AUTO_V13_LIBRARY_ID__',
        RELOAD_KEY: '__HW_PRO_AUTO_V13_RELOADS__'
    };

    const CONFIRM_LABELS = [
        'OK', 'Ok', 'Confirm', 'Yes', 'Sure', 'Continue', 'Update',
        'Update Now', 'Confirm Update', '确定', '确认', '是'
    ];

    let working = false;
    let timer = null;
    let startTime = null;
    let initialTotal = null;
    let totalProcessed = 0;
    let totalFailed = 0;
    let batchNo = 0;
    let batchHistory = [];
    let lastRemaining = null;
    let mode = null; // 'backend' | 'ui'
    let consecutiveErrors = 0;
    let softRecoveries = 0;

    let autoButton = null;
    let panel = null;
    let refreshOverlay = null;

    // ============================================================
    // NETWORK SNIFFER (library id + request activity)
    // ============================================================

    let sniffedLibraryId = null;
    let pendingRequests = 0;
    let lastRequestStart = 0;
    let lastRequestEnd = 0;

    function extractLibraryId(text) {
        if (!text) return null;

        const m = String(text).match(
            /[?&](?:extendlibraryid|extendLibraryId|libraryId|libraryid)=([^&#]+)/
        );

        if (m && m[1]) {
            const v = decodeURIComponent(m[1]).trim();
            return v || null;
        }

        return null;
    }

    function rememberLibraryId(id) {
        if (!id) return;
        sniffedLibraryId = id;
        try {
            sessionStorage.setItem(CFG.LIB_KEY, id);
        } catch (_) {}
    }

    function trackStart(url) {
        if (String(url || '').includes('_hw_auto=')) return false;
        rememberLibraryId(extractLibraryId(url));
        pendingRequests++;
        lastRequestStart = Date.now();
        return true;
    }

    function trackEnd() {
        pendingRequests = Math.max(0, pendingRequests - 1);
        lastRequestEnd = Date.now();
    }

    // Totals seen in the page's own JSON responses (e.g. the list API's
    // totalCount). Used in UI mode when the screen only shows one page.
    let sniffedTotals = [];

    function pickTotal(obj) {
        if (!obj || typeof obj !== 'object') return null;

        for (const holder of [obj, obj.data, obj.result, obj.d]) {
            if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;

            for (const key of ['totalCount', 'total', 'totalNum', 'totalSize']) {
                const v = holder[key];
                if (v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
            }
        }

        return null;
    }

    function recordTotal(text) {
        try {
            const value = pickTotal(JSON.parse(text));

            if (value !== null && value >= 0) {
                sniffedTotals.push({ value, at: Date.now() });
                if (sniffedTotals.length > 50) sniffedTotals = sniffedTotals.slice(-50);
            }
        } catch (_) {}
    }

    (function installSniffer() {
        try {
            const origFetch = window.fetch;

            if (origFetch) {
                window.fetch = function (input) {
                    let tracked = false;

                    try {
                        const url =
                            typeof input === 'string'
                                ? input
                                : (input && input.url) || '';
                        tracked = trackStart(url);
                    } catch (_) {}

                    const p = origFetch.apply(this, arguments);

                    if (tracked) {
                        p.then(res => {
                            try {
                                res.clone().text().then(recordTotal, () => {}).finally(trackEnd);
                            } catch (_) {
                                trackEnd();
                            }
                        }, trackEnd);
                    }

                    return p;
                };
            }

            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url) {
                this.__hwUrl = url;
                return origOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function () {
                try {
                    if (trackStart(this.__hwUrl)) {
                        this.addEventListener('loadend', () => {
                            try {
                                if (this.responseType === '' || this.responseType === 'text') {
                                    recordTotal(this.responseText);
                                } else if (this.responseType === 'json') {
                                    recordTotal(JSON.stringify(this.response));
                                }
                            } catch (_) {}
                            trackEnd();
                        }, { once: true });
                    }
                } catch (_) {}

                return origSend.apply(this, arguments);
            };
        } catch (e) {
            console.warn('[HW v13] Request sniffer not installed', e);
        }
    })();

    function networkIdleSince(ms) {
        return pendingRequests === 0 && Date.now() - lastRequestEnd >= ms;
    }

    function getLibraryId() {
        const fromUrl =
            extractLibraryId(location.search) ||
            extractLibraryId('?' + location.hash.replace(/^#\/?[^?]*\??/, ''));

        if (fromUrl) return fromUrl;
        if (sniffedLibraryId) return sniffedLibraryId;

        try {
            const entries = performance.getEntriesByType('resource');

            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].name.includes('_hw_auto=')) continue;

                const id = extractLibraryId(entries[i].name);

                if (id) {
                    rememberLibraryId(id);
                    return id;
                }
            }
        } catch (_) {}

        try {
            const stored = sessionStorage.getItem(CFG.LIB_KEY);
            if (stored) return stored;
        } catch (_) {}

        return null;
    }

    async function resolveMode() {
        let id = getLibraryId();

        if (!id) {
            setMessage('Looking for library id in page requests...');
            await waitFor(() => !!(id = getLibraryId()), CFG.LIBRARY_ID_WAIT_MS, 300);
        }

        if (id) {
            try {
                await getBackendStatus();
                mode = 'backend';
                console.log('[HW v13] Backend mode, libraryId =', id);
                return;
            } catch (e) {
                console.warn('[HW v13] Backend status unavailable, using UI mode', e);
            }
        }

        mode = 'ui';
        console.log('[HW v13] UI-verified mode (no usable libraryId)');
    }

    // ============================================================
    // STORAGE
    // ============================================================

    function saveState() {
        sessionStorage.setItem(
            CFG.STATS_KEY,
            JSON.stringify({
                startTime,
                initialTotal,
                totalProcessed,
                totalFailed,
                batchNo,
                batchHistory,
                lastRemaining
            })
        );
    }

    function loadState() {
        try {
            const raw = sessionStorage.getItem(CFG.STATS_KEY);
            if (!raw) return;

            const s = JSON.parse(raw);

            startTime = s.startTime || null;
            initialTotal = Number.isFinite(s.initialTotal) ? s.initialTotal : null;
            totalProcessed = Number(s.totalProcessed || 0);
            totalFailed = Number(s.totalFailed || 0);
            batchNo = Number(s.batchNo || 0);
            batchHistory = Array.isArray(s.batchHistory) ? s.batchHistory : [];
            lastRemaining =
                s.lastRemaining === null || s.lastRemaining === undefined
                    ? null
                    : Number(s.lastRemaining);
        } catch (e) {
            console.warn('[HW v13] Could not restore state', e);
        }
    }

    function clearState() {
        sessionStorage.removeItem(CFG.RUN_KEY);
        sessionStorage.removeItem(CFG.STATS_KEY);
        sessionStorage.removeItem(CFG.RELOAD_KEY);
    }

    function isRunning() {
        return sessionStorage.getItem(CFG.RUN_KEY) === '1';
    }

    function startState() {
        sessionStorage.setItem(CFG.RUN_KEY, '1');
        sessionStorage.removeItem(CFG.RELOAD_KEY);

        startTime = Date.now();
        initialTotal = null;
        totalProcessed = 0;
        totalFailed = 0;
        batchNo = 0;
        batchHistory = [];
        lastRemaining = null;
        consecutiveErrors = 0;
        softRecoveries = 0;

        saveState();
    }

    function reloadCount() {
        return Number(sessionStorage.getItem(CFG.RELOAD_KEY) || 0);
    }

    function resetReloadCount() {
        sessionStorage.removeItem(CFG.RELOAD_KEY);
    }

    // ============================================================
    // GENERAL HELPERS
    // ============================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
        if (!el) return false;
        const s = getComputedStyle(el);
        return (
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            el.getClientRects().length > 0
        );
    }

    function disabled(el) {
        if (!el) return true;
        return (
            el.disabled === true ||
            el.hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.classList.contains('disabled')
        );
    }

    function ours(el) {
        return !!(el && el.closest && el.closest('[data-hw-auto]'));
    }

    function clickElement(el) {
        if (!el) return false;

        try {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        } catch (_) {}

        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.click();

        return true;
    }

    async function waitFor(condition, timeout, interval = 200) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            if (!isRunning()) return false;

            try {
                if (condition()) return true;
            } catch (_) {}

            await sleep(interval);
        }

        return false;
    }

    function formatDuration(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '--';

        const sec = Math.round(ms / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');

        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function formatDateTime(timestamp) {
        if (!timestamp) return '--';

        return new Date(timestamp).toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    // ============================================================
    // BACKEND STATUS (only when a library id is known)
    // ============================================================

    async function getBackendStatus() {
        const libraryId = getLibraryId();

        if (!libraryId) {
            throw new Error('No library id available.');
        }

        const url =
            '/editor/api/site/model/oldversion' +
            '?toolType=cabinet&page=0&libraryId=' +
            encodeURIComponent(libraryId) +
            '&_hw_auto=' +
            Date.now();

        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: {
                'accept': '*/*',
                'editor-locale': 'en_IN',
                'x-qh-locale': 'en_IN',
                'x-qh-site': 'coohom',
                'cache-control': 'no-cache',
                'pragma': 'no-cache'
            }
        });

        if (!response.ok) {
            throw new Error('Backend status request failed: HTTP ' + response.status);
        }

        const data = await response.json();
        let remaining = null;

        if (Number.isFinite(Number(data.totalCount))) {
            remaining = Number(data.totalCount);
        } else if (Number.isFinite(Number(data.count))) {
            remaining = Number(data.count);
        } else if (Array.isArray(data.result)) {
            remaining = data.result.length;
        }

        if (remaining === null || remaining < 0) {
            throw new Error('Backend status response did not contain a usable model count.');
        }

        return { remaining };
    }

    // ============================================================
    // UNIFIED STATUS (backend or UI)
    // ============================================================

    let lastRefreshClickAt = 0;

    // The list API's own total, received since the last Refresh List.
    // Lets UI mode see the real count when the screen shows one page.
    function listTotalSinceRefresh(pageTotal) {
        for (let i = sniffedTotals.length - 1; i >= 0; i--) {
            const t = sniffedTotals[i];
            if (t.at < lastRefreshClickAt) break;
            if (t.value >= pageTotal) return t.value;
        }

        return null;
    }

    function uiRemaining() {
        if (emptyState()) return 0;
        const s = currentSelection();
        if (!s) return null;
        const apiTotal = listTotalSinceRefresh(s.total);
        return apiTotal !== null ? apiTotal : s.total;
    }

    // Identity of the model cards on screen (used only to detect that
    // a refreshed page shows different models).
    function cardsFingerprint() {
        return Array.from(document.querySelectorAll('img'))
            .filter(img => visible(img) && !ours(img))
            .slice(0, 200)
            .map(img => img.getAttribute('src') + '#' + (img.getAttribute('alt') || ''))
            .join('|');
    }

    async function getRemaining() {
        if (mode === 'backend') {
            return (await getBackendStatus()).remaining;
        }

        const r = uiRemaining();

        if (r === null) {
            throw new Error('Could not read "Selected X / Y" from the Coohom page.');
        }

        return r;
    }

    /*
     * Returns { remaining, processed }, null if stopped, or
     * { stalled: true, count } if nothing changed within STALL_MS.
     */
    async function waitForDecrease(beforeCount, beforeCards, selectedCount) {
        const started = Date.now();
        let lastCount = beforeCount;

        setPhase('VERIFYING', 'blue');
        setMessage('Waiting for Coohom to finish this batch...');

        await sleep(CFG.UPDATE_SETTLE_MS);

        while (Date.now() - started < CFG.STALL_MS) {
            if (!isRunning()) return null;

            try {
                if (mode === 'ui') {
                    await refreshList();
                    if (!isRunning()) return null;
                }

                const remaining = await getRemaining();
                lastCount = remaining;
                lastRemaining = remaining;
                updateDashboard();

                if (remaining < beforeCount) {
                    return { remaining, processed: beforeCount - remaining };
                }

                // UI mode, paged list: the count can stay the same while the
                // shown models are replaced by the next page of old ones.
                if (mode === 'ui' && remaining === beforeCount && beforeCards) {
                    const cards = cardsFingerprint();

                    if (cards && cards !== beforeCards) {
                        return { remaining, processed: selectedCount };
                    }
                }

                setMessage(
                    `Still ${remaining} models. Waiting for update completion... (` +
                    Math.round((Date.now() - started) / 1000) + 's)'
                );
            } catch (error) {
                console.warn('[HW v13] Status check:', error);
            }

            await sleep(mode === 'ui' ? CFG.UI_POLL_MS : CFG.BACKEND_POLL_MS);
        }

        return { stalled: true, count: lastCount };
    }

    async function verifyZero() {
        await sleep(CFG.FINAL_VERIFY_DELAY_MS);

        for (let i = 0; i < CFG.FINAL_VERIFY_PASSES; i++) {
            if (!isRunning()) return false;

            if (mode === 'ui') {
                await refreshList();
            }

            if ((await getRemaining()) !== 0) return false;

            if (i < CFG.FINAL_VERIFY_PASSES - 1) {
                await sleep(CFG.BACKEND_POLL_MS);
            }
        }

        return true;
    }

    // ============================================================
    // FRONTEND STATE
    // ============================================================

    function pageText() {
        // Read the Coohom page text without our own panel/overlay.
        if (!document.body) return '';

        let text = document.body.innerText || '';

        document.querySelectorAll('[data-hw-auto]').forEach(el => {
            const t = el.innerText;
            if (t) text = text.split(t).join(' ');
        });

        return text;
    }

    function currentSelection() {
        const match = pageText().match(/Selected\s+(\d+)\s*\/\s*(\d+)/i);

        if (!match) return null;

        return { selected: Number(match[1]), total: Number(match[2]) };
    }

    function emptyState() {
        const sel = currentSelection();

        return (
            pageText().includes('No model has parts to be updated') ||
            (sel !== null && sel.total === 0)
        );
    }

    function readable() {
        return emptyState() || currentSelection() !== null;
    }

    // ============================================================
    // FIND CONTROLS
    // ============================================================

    function buttons(root = document) {
        return Array.from(
            root.querySelectorAll('button,[role="button"],a')
        ).filter(el => visible(el) && !ours(el));
    }

    function findButton(label) {
        return buttons().find(el => cleanText(el.textContent) === label) || null;
    }

    function findUpdatePart() {
        return findButton('Update Part');
    }

    function findRefreshList() {
        return findButton('Refresh List');
    }

    function findSelectAllCheckbox() {
        const boxes = Array.from(
            document.querySelectorAll('input[type="checkbox"]')
        ).filter(el => visible(el) || visible(el.parentElement))
         .filter(el => !ours(el));

        for (const box of boxes) {
            let node = box;

            for (let i = 0; i < 6 && node; i++) {
                const t = cleanText(node.textContent);

                if (t.includes('Select All') && t.length < 400) {
                    // antd hides the real input; click its visible wrapper.
                    return visible(box) ? box : box.parentElement;
                }

                node = node.parentElement;
            }
        }

        const first = boxes[0];
        return first ? (visible(first) ? first : first.parentElement) : null;
    }

    function findConfirmButton() {
        const dialogs = Array.from(
            document.querySelectorAll(
                '.ant-modal, .ant-modal-confirm, .ant-popover, .ant-popconfirm, ' +
                '[role="dialog"], [role="alertdialog"], .modal, .el-message-box, .el-dialog'
            )
        ).filter(el => visible(el) && !ours(el));

        for (const dlg of dialogs) {
            const btn = buttons(dlg).find(
                el => CONFIRM_LABELS.includes(cleanText(el.textContent)) && !disabled(el)
            );

            if (btn) return btn;
        }

        return null;
    }

    // ============================================================
    // UI
    // ============================================================

    function createUI() {
        if (document.getElementById('hw-v13-auto-button')) return;

        autoButton = document.createElement('button');
        autoButton.id = 'hw-v13-auto-button';
        autoButton.setAttribute('data-hw-auto', '1');

        Object.assign(autoButton.style, {
            position: 'fixed',
            top: '18px',
            right: '24px',
            zIndex: '2147483647',
            padding: '11px 18px',
            border: '0',
            borderRadius: '7px',
            background: isRunning() ? '#dc2626' : '#1677ff',
            color: '#fff',
            fontSize: '13px',
            fontWeight: '700',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,.22)'
        });

        autoButton.textContent = isRunning() ? 'STOP AUTO UPDATE' : 'AUTO UPDATE ALL';

        panel = document.createElement('div');
        panel.id = 'hw-v13-panel';
        panel.setAttribute('data-hw-auto', '1');

        Object.assign(panel.style, {
            position: 'fixed',
            top: '62px',
            right: '24px',
            zIndex: '2147483646',
            width: '330px',
            padding: '14px',
            borderRadius: '10px',
            background: 'rgba(255,255,255,.97)',
            color: '#172033',
            fontFamily: 'Arial, Helvetica, sans-serif',
            fontSize: '12px',
            boxShadow: '0 8px 28px rgba(0,0,0,.20)',
            border: '1px solid #e5e7eb'
        });

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <div style="font-size:14px;font-weight:700;">Auto Update Monitor</div>
                <div id="hw-v13-phase" style="padding:3px 7px;border-radius:10px;background:#eef2ff;color:#4338ca;font-size:10px;font-weight:700;">READY</div>
            </div>
            <div style="height:8px;background:#edf0f4;border-radius:8px;overflow:hidden;margin-bottom:12px;">
                <div id="hw-v13-progress" style="width:0%;height:100%;background:#1677ff;border-radius:8px;transition:width .4s ease;"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                ${statBox('Remaining', 'hw-v13-remaining')}
                ${statBox('Processed', 'hw-v13-processed')}
                ${statBox('Batch', 'hw-v13-batch')}
                ${statBox('Progress', 'hw-v13-percent')}
            </div>
            <div style="margin-top:10px;border-top:1px solid #edf0f4;padding-top:10px;">
                ${line('Mode', 'hw-v13-mode')}
                ${line('Auto recoveries', 'hw-v13-recover')}
                ${line('Elapsed', 'hw-v13-elapsed')}
                ${line('Avg. batch', 'hw-v13-avgbatch')}
                ${line('ETA', 'hw-v13-eta')}
                ${line('Estimated finish', 'hw-v13-finish')}
            </div>
            <div id="hw-v13-message" style="margin-top:10px;padding:8px 9px;border-radius:6px;background:#f6f8fa;color:#4b5563;line-height:1.4;">Ready to start.</div>
        `;

        refreshOverlay = document.createElement('div');
        refreshOverlay.id = 'hw-v13-refresh-overlay';
        refreshOverlay.setAttribute('data-hw-auto', '1');

        Object.assign(refreshOverlay.style, {
            display: 'none',
            position: 'fixed',
            inset: '0',
            zIndex: '2147483640',
            background: 'rgba(255,255,255,.55)',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto'
        });

        refreshOverlay.innerHTML = `
            <div style="padding:14px 18px;border-radius:10px;background:#fff;border:1px solid #e5e7eb;box-shadow:0 8px 30px rgba(0,0,0,.16);font-family:Arial,Helvetica,sans-serif;text-align:center;color:#172033;">
                <div style="font-size:13px;font-weight:700;">Synchronizing Coohom model list</div>
                <div style="font-size:11px;color:#6b7280;margin-top:5px;">Please wait — native UI is refreshing</div>
            </div>
        `;

        document.body.appendChild(autoButton);
        document.body.appendChild(panel);
        document.body.appendChild(refreshOverlay);

        autoButton.addEventListener('click', () => {
            if (isRunning()) {
                clearState();
                stopClock();
                hideRefreshOverlay();
                autoButton.textContent = 'AUTO UPDATE ALL';
                autoButton.style.background = '#1677ff';
                setPhase('STOPPED', 'red');
                setMessage('Automation stopped by user.');
                return;
            }

            startState();
            autoButton.textContent = 'STOP AUTO UPDATE';
            autoButton.style.background = '#dc2626';
            startClock();
            setPhase('STARTING', 'blue');
            setMessage('Starting automation...');
            run();
        });

        updateDashboard();
    }

    function statBox(label, id) {
        return `
            <div style="padding:8px;border:1px solid #edf0f4;border-radius:6px;background:#fafbfc;">
                <div style="font-size:10px;color:#7a8494;margin-bottom:3px;">${label}</div>
                <div id="${id}" style="font-size:14px;font-weight:700;color:#172033;">--</div>
            </div>
        `;
    }

    function line(label, id) {
        return `
            <div style="display:flex;justify-content:space-between;gap:12px;margin:5px 0;">
                <span style="color:#6b7280">${label}</span>
                <span id="${id}" style="font-weight:700;text-align:right;">--</span>
            </div>
        `;
    }

    function setPhase(value, color) {
        const el = document.getElementById('hw-v13-phase');
        if (!el) return;

        el.textContent = String(value).toUpperCase();

        const colors = {
            green: ['#dcfce7', '#166534'],
            red: ['#fee2e2', '#991b1b']
        }[color] || ['#eef2ff', '#4338ca'];

        el.style.background = colors[0];
        el.style.color = colors[1];
    }

    function setMessage(message) {
        const el = document.getElementById('hw-v13-message');
        if (el) el.textContent = message;
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function startClock() {
        stopClock();
        timer = setInterval(updateDashboard, CFG.CLOCK_MS);
        updateDashboard();
    }

    function stopClock() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // ============================================================
    // LIVE ETA
    // ============================================================

    function calculateStats() {
        const elapsed = startTime ? Date.now() - startTime : null;

        if (!startTime || initialTotal === null) {
            return { progress: 0, remaining: null, processed: totalProcessed, avgBatch: null, eta: null, finish: null, elapsed };
        }

        const remaining = Math.max(
            0,
            lastRemaining === null ? initialTotal - totalProcessed : lastRemaining
        );

        const progress = initialTotal > 0
            ? Math.max(0, Math.min(100, ((initialTotal - remaining) / initialTotal) * 100))
            : 100;

        const recent = batchHistory
            .map(x => Number(x.duration))
            .filter(x => Number.isFinite(x) && x > 0)
            .slice(-5);

        const avgBatch = recent.length
            ? recent.reduce((a, b) => a + b, 0) / recent.length
            : null;

        const recentSuccessful = batchHistory
            .filter(x => Number(x.processed) > 0)
            .slice(-5);

        const avgProcessedPerBatch = recentSuccessful.length
            ? recentSuccessful.reduce((s, x) => s + Number(x.processed), 0) / recentSuccessful.length
            : null;

        let eta = null;

        if (avgBatch !== null && avgProcessedPerBatch && remaining > 0) {
            eta = Math.ceil(remaining / avgProcessedPerBatch) * avgBatch;
        }

        return {
            progress,
            remaining,
            processed: Math.max(0, initialTotal - remaining),
            avgBatch,
            eta,
            finish: eta !== null ? Date.now() + eta : null,
            elapsed
        };
    }

    function updateDashboard() {
        if (!panel) return;

        const stats = calculateStats();

        setText('hw-v13-remaining', stats.remaining === null ? '--' : String(stats.remaining));
        setText('hw-v13-processed', String(stats.processed ?? 0));
        setText('hw-v13-batch', String(batchNo));
        setText('hw-v13-percent', stats.progress.toFixed(1) + '%');
        setText('hw-v13-mode', mode === 'backend' ? 'Backend verified' : mode === 'ui' ? 'UI verified' : '--');
        setText('hw-v13-recover', `${softRecoveries} soft / ${reloadCount()} reload`);
        setText('hw-v13-elapsed', formatDuration(stats.elapsed));
        setText('hw-v13-avgbatch', stats.avgBatch ? formatDuration(stats.avgBatch) : '--');
        setText('hw-v13-eta', stats.eta !== null ? formatDuration(stats.eta) : 'Calculating...');
        setText('hw-v13-finish', stats.finish !== null ? formatDateTime(stats.finish) : 'Calculating...');

        const bar = document.getElementById('hw-v13-progress');
        if (bar) bar.style.width = Math.max(0, Math.min(100, stats.progress || 0)) + '%';
    }

    // ============================================================
    // NATIVE ACTIONS
    // ============================================================

    async function selectAll() {
        const isAll = () => {
            const s = currentSelection();
            return s && s.total > 0 && s.selected === s.total;
        };

        if (isAll()) return currentSelection();

        setPhase('SELECTING', 'blue');
        setMessage('Selecting all models currently displayed...');

        // Up to 3 clicks: none → all, or partial → none → all.
        for (let attempt = 0; attempt < 3; attempt++) {
            const checkbox = findSelectAllCheckbox();

            if (!checkbox) throw new Error('Select All checkbox not found.');

            clickElement(checkbox);

            if (await waitFor(isAll, attempt === 0 ? CFG.SELECT_TIMEOUT_MS : 2500)) {
                return currentSelection();
            }

            if (!isRunning()) return null;
        }

        const s = currentSelection();

        // Accept a non-empty selection if the page caps how many can be selected.
        if (s && s.selected > 0) return s;

        throw new Error('Select All did not select the models.');
    }

    async function updatePart() {
        if (!findUpdatePart()) throw new Error('Update Part button not found.');

        const enabled = await waitFor(() => {
            const b = findUpdatePart();
            return b && !disabled(b);
        }, 6000);

        if (!enabled) throw new Error('Update Part button is disabled.');

        await sleep(CFG.BEFORE_UPDATE_MS);

        setPhase('UPDATING', 'blue');
        setMessage('Homworks Studio is processing the selected parts...');

        clickElement(findUpdatePart());

        // Auto-confirm a dialog if Coohom asks for one.
        let confirmBtn = null;

        await waitFor(() => !!(confirmBtn = findConfirmButton()), CFG.CONFIRM_WAIT_MS, 150);

        if (confirmBtn) {
            setMessage('Confirming update dialog...');
            clickElement(confirmBtn);
            await sleep(300);
        }
    }

    function showRefreshOverlay() {
        if (refreshOverlay) refreshOverlay.style.display = 'flex';
    }

    function hideRefreshOverlay() {
        if (refreshOverlay) refreshOverlay.style.display = 'none';
    }

    async function refreshList() {
        const button = findRefreshList();

        if (!button) throw new Error('Refresh List button not found.');

        await sleep(CFG.REFRESH_CLICK_DELAY_MS);

        setPhase('REFRESHING UI', 'blue');
        showRefreshOverlay();

        const clickedAt = Date.now();
        lastRefreshClickAt = clickedAt;
        clickElement(button);

        const started = Date.now();
        let lastSig = null;
        let stableSince = 0;

        try {
            while (Date.now() - started < CFG.REFRESH_TIMEOUT_MS) {
                if (!isRunning()) return false;

                // The list counts as reloaded only after a request that
                // started after our click has finished and the network
                // is quiet. Fallback: after 4s without any request.
                const netDone =
                    (lastRequestStart >= clickedAt && networkIdleSince(CFG.NET_IDLE_MS)) ||
                    (lastRequestStart < clickedAt && Date.now() - clickedAt > 4000);

                const sel = currentSelection();
                const sig = sel ? sel.selected + '/' + sel.total : (emptyState() ? 'empty' : null);

                if (sig !== null && sig === lastSig) {
                    if (!stableSince) stableSince = Date.now();

                    if (netDone && Date.now() - stableSince >= CFG.UI_STABLE_MS) {
                        return true;
                    }
                } else {
                    lastSig = sig;
                    stableSince = sig !== null ? Date.now() : 0;
                }

                await sleep(150);
            }

            await sleep(1000);

            if (readable()) return true;

            throw new Error('Coohom native UI did not become readable after Refresh List.');
        } finally {
            hideRefreshOverlay();
        }
    }

    // Backend mode: make sure the UI list is not older than the backend.
    async function refreshUntilFresh() {
        for (let i = 0; i <= CFG.MAX_STALE_REFRESHES; i++) {
            await refreshList();
            if (!isRunning()) return;

            await waitFor(readable, 8000);

            if (mode !== 'backend') return;

            const backend = await getRemaining();
            const ui = uiRemaining();

            if (ui === null || ui <= backend) return;

            setMessage(`UI shows ${ui} but backend has ${backend}. Refreshing again...`);
        }

        throw new Error('Coohom list stayed stale after several refreshes.');
    }

    // ============================================================
    // SELF-HEALING
    // ============================================================

    function hardReload(reason) {
        const n = reloadCount() + 1;

        if (n > CFG.MAX_RELOADS_NO_PROGRESS) {
            stopWithError(
                `Stopped after ${CFG.MAX_RELOADS_NO_PROGRESS} automatic page reloads without progress. ` +
                `Last problem: ${reason}`
            );
            return;
        }

        sessionStorage.setItem(CFG.RELOAD_KEY, String(n));
        saveState();

        setPhase('RELOADING', 'red');
        setMessage(`Auto-recovery: reloading page (${n}/${CFG.MAX_RELOADS_NO_PROGRESS}). ${reason}`);

        setTimeout(() => location.reload(), 800);
    }

    function stopWithError(message) {
        sessionStorage.removeItem(CFG.RUN_KEY);
        sessionStorage.removeItem(CFG.RELOAD_KEY);
        stopClock();
        hideRefreshOverlay();

        setPhase('STOPPED', 'red');
        setMessage('ERROR: ' + message);

        if (autoButton) {
            autoButton.textContent = 'AUTO UPDATE ALL';
            autoButton.style.background = '#1677ff';
        }
    }

    function recordProgress() {
        consecutiveErrors = 0;
        softRecoveries = 0;
        resetReloadCount();
    }

    // ============================================================
    // MAIN LOOP
    // ============================================================

    async function run() {
        if (working || !isRunning()) return;

        working = true;
        let retry = false;
        let reloading = false;

        try {
            await sleep(CFG.PAGE_READY_MS);

            if (!(await waitFor(readable, CFG.PAGE_READABLE_TIMEOUT_MS))) {
                if (!isRunning()) return;
                throw new Error('Coohom model list did not load.');
            }

            if (!mode) {
                await resolveMode();
                updateDashboard();
            }

            let remaining = await getRemaining();

            if (initialTotal === null) {
                initialTotal = remaining;
                lastRemaining = remaining;
                saveState();
                updateDashboard();
            }

            let needsRefresh = false;

            while (isRunning()) {
                if (needsRefresh && mode === 'backend') {
                    await refreshUntilFresh();
                    if (!isRunning()) break;
                }

                needsRefresh = false;

                remaining = await getRemaining();
                lastRemaining = remaining;
                updateDashboard();

                if (remaining === 0) {
                    if (await verifyZero()) {
                        if (mode === 'backend') {
                            try {
                                await refreshList();
                            } catch (_) {}
                        }

                        finishSuccess();
                        break;
                    }

                    needsRefresh = true;
                    await sleep(CFG.BACKEND_POLL_MS);
                    continue;
                }

                if (emptyState()) {
                    setPhase('SYNCING', 'blue');
                    setMessage(`Coohom UI is temporarily empty but ${remaining} models remain. Refreshing...`);
                    needsRefresh = true;
                    await sleep(1000);
                    continue;
                }

                const beforeCount = remaining;

                batchNo++;
                const batchStart = Date.now();

                setPhase('BATCH ' + batchNo, 'blue');
                setMessage(`Starting batch ${batchNo}. ${beforeCount} models remaining.`);

                const selection = await selectAll();
                if (!isRunning()) break;

                const beforeCards = cardsFingerprint();

                await updatePart();

                const result = await waitForDecrease(
                    beforeCount,
                    beforeCards,
                    selection ? selection.selected : 0
                );

                if (result === null) break;

                if (typeof result === 'object' && result.stalled) {
                    batchNo--;
                    softRecoveries++;
                    updateDashboard();

                    if (softRecoveries > CFG.MAX_SOFT_RECOVERIES) {
                        reloading = true;
                        hardReload(`Batch stalled at ${result.count} models.`);
                        return;
                    }

                    setPhase('RECOVERING', 'red');
                    setMessage(
                        `No progress for ${Math.round(CFG.STALL_MS / 1000)}s at ${result.count} models. ` +
                        `Auto-refreshing and retrying (${softRecoveries}/${CFG.MAX_SOFT_RECOVERIES})...`
                    );

                    // Force a fresh list (both modes) before redoing the batch.
                    await refreshList();
                    await waitFor(readable, 8000);
                    continue;
                }

                const afterCount = result.remaining;
                const processed = Math.max(0, result.processed);

                totalProcessed += processed;
                lastRemaining = afterCount;

                batchHistory.push({
                    batch: batchNo,
                    before: beforeCount,
                    after: afterCount,
                    processed,
                    duration: Date.now() - batchStart
                });

                if (batchHistory.length > 30) batchHistory = batchHistory.slice(-30);

                recordProgress();
                saveState();
                updateDashboard();

                setPhase('BATCH COMPLETE', 'green');
                setMessage(`Batch ${batchNo} verified: ${processed} models updated. ${afterCount} models remaining.`);

                // In UI mode waitForDecrease already refreshed the list.
                needsRefresh = true;

                await sleep(350);
            }
        } catch (error) {
            console.error('[HW v13]', error);

            totalFailed++;
            consecutiveErrors++;
            hideRefreshOverlay();
            saveState();

            if (consecutiveErrors >= CFG.MAX_CONSECUTIVE_ERRORS && isRunning()) {
                reloading = true;
                hardReload(error?.message || String(error));
            } else {
                setPhase('ERROR', 'red');
                setMessage(
                    'ERROR: ' + (error?.message || String(error)) +
                    ` — auto-retrying (${consecutiveErrors}/${CFG.MAX_CONSECUTIVE_ERRORS})...`
                );
                retry = true;
            }
        } finally {
            if (!reloading) working = false;
        }

        if (retry && isRunning()) {
            await sleep(CFG.RETRY_MS);
            if (isRunning()) run();
        }
    }

    // ============================================================
    // FINISH
    // ============================================================

    function finishSuccess() {
        lastRemaining = 0;
        saveState();
        updateDashboard();
        stopClock();

        setPhase('COMPLETE', 'green');
        setMessage(
            '✓ VERIFIED COMPLETE — 0 models remaining (' +
            (mode === 'backend' ? 'backend' : 'UI') +
            ' verified). Total time: ' +
            formatDuration(startTime ? Date.now() - startTime : 0) +
            '.'
        );

        if (autoButton) {
            autoButton.textContent = 'AUTO UPDATE ALL';
            autoButton.style.background = '#1677ff';
        }

        sessionStorage.removeItem(CFG.RUN_KEY);
        sessionStorage.removeItem(CFG.RELOAD_KEY);
    }

    // ============================================================
    // INIT
    // ============================================================

    function init() {
        loadState();
        createUI();

        if (isRunning()) {
            startClock();
            setPhase('RESUMING', 'blue');
            setMessage(
                reloadCount() > 0
                    ? `Resumed automatically after recovery reload ${reloadCount()}/${CFG.MAX_RELOADS_NO_PROGRESS}...`
                    : 'Resuming Auto Update...'
            );
            setTimeout(run, 600);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
