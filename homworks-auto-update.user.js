// ==UserScript==
// @name         Homworks Studio - Professional Auto Update v12
// @namespace    http://tampermonkey.net/
// @version      12.0
// @description  Auto Update using native Coohom controls. Works with or without extendlibraryid in the URL (auto-detects the library id, falls back to UI-verified mode).
// @match        https://www.homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @match        https://homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /*
     * ============================================================
     * HOMWORKS STUDIO - PROFESSIONAL AUTO UPDATE v12
     * ============================================================
     *
     * Changes vs v11:
     * - Works when the URL is ".../list?extendlibraryid=" (empty).
     *   The library id is detected from the URL, from the page's own
     *   network requests (fetch / XHR / performance entries), or from
     *   storage. If it still cannot be found, the script runs in
     *   UI-VERIFIED mode: progress is read from "Selected X / Y" after
     *   the native Refresh List.
     * - Fixed: retry after an error never ran (run() was re-entered
     *   while `working` was still true).
     * - Fixed: Refresh List was clicked twice per batch.
     */

    const CFG = {
        UPDATE_SETTLE_MS: 1800,
        REFRESH_CLICK_DELAY_MS: 250,
        REFRESH_TIMEOUT_MS: 12000,
        BACKEND_POLL_MS: 1000,
        BACKEND_TIMEOUT_MS: 120000,
        UI_POLL_MS: 3000,
        FINAL_VERIFY_DELAY_MS: 1800,
        FINAL_VERIFY_PASSES: 2,
        UI_STABLE_MS: 900,
        SELECT_TIMEOUT_MS: 8000,
        PAGE_READY_MS: 700,
        LIBRARY_ID_WAIT_MS: 6000,
        BEFORE_UPDATE_MS: 250,
        RETRY_MS: 2500,
        CLOCK_MS: 1000,
        RUN_KEY: '__HW_PRO_AUTO_V12_RUNNING__',
        STATS_KEY: '__HW_PRO_AUTO_V12_STATS__',
        LIB_KEY: '__HW_PRO_AUTO_V12_LIBRARY_ID__'
    };

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

    let autoButton = null;
    let panel = null;
    let refreshOverlay = null;

    // ============================================================
    // LIBRARY ID DETECTION
    // ============================================================

    let sniffedLibraryId = null;

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

    // Runs at document-start: watch the page's own requests for libraryId.
    (function installSniffer() {
        try {
            const origFetch = window.fetch;

            if (origFetch) {
                window.fetch = function (input, init) {
                    try {
                        const url =
                            typeof input === 'string'
                                ? input
                                : (input && input.url) || '';

                        if (!url.includes('_hw_auto=')) {
                            rememberLibraryId(extractLibraryId(url));
                        }
                    } catch (_) {}

                    return origFetch.apply(this, arguments);
                };
            }

            const origOpen = XMLHttpRequest.prototype.open;

            XMLHttpRequest.prototype.open = function (method, url) {
                try {
                    rememberLibraryId(extractLibraryId(url));
                } catch (_) {}

                return origOpen.apply(this, arguments);
            };
        } catch (e) {
            console.warn('[HW v12] Request sniffer not installed', e);
        }
    })();

    function getLibraryId() {
        // 1. URL query / hash
        const fromUrl =
            extractLibraryId(location.search) ||
            extractLibraryId('?' + location.hash.replace(/^#\/?[^?]*\??/, ''));

        if (fromUrl) return fromUrl;

        // 2. Page's own network requests
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

        // 3. Remembered from earlier in this tab
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
                console.log('[HW v12] Backend mode, libraryId =', id);
                return;
            } catch (e) {
                console.warn('[HW v12] Backend status unavailable, using UI mode', e);
            }
        }

        mode = 'ui';
        console.log('[HW v12] UI-verified mode (no usable libraryId)');
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
            console.warn('[HW v12] Could not restore state', e);
        }
    }

    function clearState() {
        sessionStorage.removeItem(CFG.RUN_KEY);
        sessionStorage.removeItem(CFG.STATS_KEY);
    }

    function isRunning() {
        return sessionStorage.getItem(CFG.RUN_KEY) === '1';
    }

    function startState() {
        sessionStorage.setItem(CFG.RUN_KEY, '1');

        startTime = Date.now();
        initialTotal = null;
        totalProcessed = 0;
        totalFailed = 0;
        batchNo = 0;
        batchHistory = [];
        lastRemaining = null;

        saveState();
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

    function uiRemaining() {
        if (emptyState()) return 0;
        const s = currentSelection();
        return s ? s.total : null;
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

    async function waitForDecrease(beforeCount) {
        const started = Date.now();
        let lastError = null;
        let lastCount = beforeCount;

        setPhase('VERIFYING', 'blue');
        setMessage('Waiting for Coohom to finish this batch...');

        await sleep(CFG.UPDATE_SETTLE_MS);

        while (Date.now() - started < CFG.BACKEND_TIMEOUT_MS) {
            if (!isRunning()) return null;

            try {
                // In UI mode the list must be refreshed to see the new count.
                if (mode === 'ui') {
                    await refreshList();
                    if (!isRunning()) return null;
                }

                const remaining = await getRemaining();
                lastCount = remaining;
                lastError = null;
                lastRemaining = remaining;
                updateDashboard();

                if (remaining < beforeCount) {
                    return remaining;
                }

                setMessage(`Still ${remaining} models. Waiting for update completion...`);
            } catch (error) {
                lastError = error;
                console.warn('[HW v12] Status check:', error);
            }

            await sleep(mode === 'ui' ? CFG.UI_POLL_MS : CFG.BACKEND_POLL_MS);
        }

        throw new Error(
            'Model count did not decrease within ' +
            Math.round(CFG.BACKEND_TIMEOUT_MS / 1000) +
            ' seconds. Last count: ' +
            lastCount +
            (lastError ? ' (' + lastError.message + ')' : '')
        );
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

    function currentSelection() {
        const body = document.body ? document.body.innerText || '' : '';
        const match = body.match(/Selected\s+(\d+)\s*\/\s*(\d+)/i);

        if (!match) return null;

        return { selected: Number(match[1]), total: Number(match[2]) };
    }

    function emptyState() {
        const body = document.body ? document.body.innerText || '' : '';
        const sel = currentSelection();

        return (
            body.includes('No model has parts to be updated.') ||
            (sel !== null && sel.total === 0)
        );
    }

    // ============================================================
    // FIND CONTROLS
    // ============================================================

    function buttons() {
        return Array.from(
            document.querySelectorAll('button,[role="button"],a')
        ).filter(visible);
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
        ).filter(visible);

        for (const box of boxes) {
            let node = box;

            for (let i = 0; i < 6 && node; i++) {
                const t = cleanText(node.textContent);

                if (t.includes('Select All') && t.length < 400) {
                    return box;
                }

                node = node.parentElement;
            }
        }

        return boxes[0] || null;
    }

    // ============================================================
    // UI
    // ============================================================

    function createUI() {
        if (document.getElementById('hw-v12-auto-button')) return;

        autoButton = document.createElement('button');
        autoButton.id = 'hw-v12-auto-button';

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
        panel.id = 'hw-v12-panel';

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
                <div id="hw-v12-phase" style="padding:3px 7px;border-radius:10px;background:#eef2ff;color:#4338ca;font-size:10px;font-weight:700;">READY</div>
            </div>
            <div style="height:8px;background:#edf0f4;border-radius:8px;overflow:hidden;margin-bottom:12px;">
                <div id="hw-v12-progress" style="width:0%;height:100%;background:#1677ff;border-radius:8px;transition:width .4s ease;"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                ${statBox('Remaining', 'hw-v12-remaining')}
                ${statBox('Processed', 'hw-v12-processed')}
                ${statBox('Batch', 'hw-v12-batch')}
                ${statBox('Progress', 'hw-v12-percent')}
            </div>
            <div style="margin-top:10px;border-top:1px solid #edf0f4;padding-top:10px;">
                ${line('Mode', 'hw-v12-mode')}
                ${line('Elapsed', 'hw-v12-elapsed')}
                ${line('Avg. batch', 'hw-v12-avgbatch')}
                ${line('ETA', 'hw-v12-eta')}
                ${line('Estimated finish', 'hw-v12-finish')}
            </div>
            <div id="hw-v12-message" style="margin-top:10px;padding:8px 9px;border-radius:6px;background:#f6f8fa;color:#4b5563;line-height:1.4;">Ready to start.</div>
        `;

        refreshOverlay = document.createElement('div');
        refreshOverlay.id = 'hw-v12-refresh-overlay';

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
        const el = document.getElementById('hw-v12-phase');
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
        const el = document.getElementById('hw-v12-message');
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

        setText('hw-v12-remaining', stats.remaining === null ? '--' : String(stats.remaining));
        setText('hw-v12-processed', String(stats.processed ?? 0));
        setText('hw-v12-batch', String(batchNo));
        setText('hw-v12-percent', stats.progress.toFixed(1) + '%');
        setText('hw-v12-mode', mode === 'backend' ? 'Backend verified' : mode === 'ui' ? 'UI verified' : '--');
        setText('hw-v12-elapsed', formatDuration(stats.elapsed));
        setText('hw-v12-avgbatch', stats.avgBatch ? formatDuration(stats.avgBatch) : '--');
        setText('hw-v12-eta', stats.eta !== null ? formatDuration(stats.eta) : 'Calculating...');
        setText('hw-v12-finish', stats.finish !== null ? formatDateTime(stats.finish) : 'Calculating...');

        const bar = document.getElementById('hw-v12-progress');
        if (bar) bar.style.width = Math.max(0, Math.min(100, stats.progress || 0)) + '%';
    }

    // ============================================================
    // NATIVE ACTIONS
    // ============================================================

    async function selectAll() {
        const current = currentSelection();

        if (current && current.selected > 0) return current;

        const checkbox = findSelectAllCheckbox();

        if (!checkbox) throw new Error('Select All checkbox not found.');

        setPhase('SELECTING', 'blue');
        setMessage('Selecting all models currently displayed...');

        clickElement(checkbox);

        const ok = await waitFor(() => {
            const s = currentSelection();
            return s && s.selected > 0;
        }, CFG.SELECT_TIMEOUT_MS);

        if (!ok) throw new Error('Select All did not select the models.');

        return currentSelection();
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
        clickElement(button);

        const started = Date.now();
        let lastCount = null;
        let stableSince = 0;

        try {
            while (Date.now() - started < CFG.REFRESH_TIMEOUT_MS) {
                if (!isRunning()) return false;

                const state = currentSelection();

                if (state) {
                    if (state.total === lastCount) {
                        if (!stableSince) stableSince = Date.now();
                        if (Date.now() - stableSince >= CFG.UI_STABLE_MS) return true;
                    } else {
                        lastCount = state.total;
                        stableSince = Date.now();
                    }
                } else if (emptyState()) {
                    return true;
                } else {
                    stableSince = 0;
                }

                await sleep(150);
            }

            await sleep(1000);

            if (currentSelection() || emptyState()) return true;

            throw new Error('Coohom native UI did not become readable after Refresh List.');
        } finally {
            hideRefreshOverlay();
        }
    }

    // ============================================================
    // MAIN LOOP
    // ============================================================

    async function run() {
        if (working || !isRunning()) return;

        working = true;
        let retry = false;

        try {
            await sleep(CFG.PAGE_READY_MS);

            if (!mode) {
                await resolveMode();
                updateDashboard();
            }

            // Wait until the native list is readable before reading counts.
            await waitFor(() => emptyState() || currentSelection() !== null, 10000);

            let remaining = await getRemaining();

            if (initialTotal === null) {
                initialTotal = remaining;
                lastRemaining = remaining;
                saveState();
                updateDashboard();
            }

            // The page is already fresh at start; only refresh after a batch.
            let needsRefresh = false;

            while (isRunning()) {
                if (needsRefresh && mode === 'backend') {
                    await refreshList();
                    if (!isRunning()) break;
                    await waitFor(() => emptyState() || currentSelection() !== null, 8000);
                }

                needsRefresh = false;

                remaining = await getRemaining();
                lastRemaining = remaining;
                updateDashboard();

                if (remaining === 0) {
                    if (await verifyZero()) {
                        finishSuccess();
                        break;
                    }

                    needsRefresh = true;
                    await sleep(CFG.BACKEND_POLL_MS);
                    continue;
                }

                if (emptyState()) {
                    setPhase('SYNCING', 'blue');
                    setMessage(`Coohom UI is temporarily empty but ${remaining} models remain. Waiting for native UI...`);
                    needsRefresh = true;
                    await sleep(1000);
                    continue;
                }

                const beforeCount = remaining;

                batchNo++;
                const batchStart = Date.now();

                setPhase('BATCH ' + batchNo, 'blue');
                setMessage(`Starting batch ${batchNo}. ${beforeCount} models remaining.`);

                await selectAll();
                await updatePart();

                const afterCount = await waitForDecrease(beforeCount);

                if (afterCount === null) break;

                const processed = Math.max(0, beforeCount - afterCount);

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

                saveState();
                updateDashboard();

                setPhase('BATCH COMPLETE', 'green');
                setMessage(`Batch ${batchNo} verified: ${processed} models updated. ${afterCount} models remaining.`);

                // In UI mode waitForDecrease already refreshed the list.
                needsRefresh = true;

                await sleep(350);
            }
        } catch (error) {
            console.error('[HW v12]', error);

            totalFailed++;
            hideRefreshOverlay();
            setPhase('ERROR', 'red');
            setMessage('ERROR: ' + (error?.message || String(error)) + ' — retrying...');
            saveState();

            retry = true;
        } finally {
            working = false;
        }

        // Retry only after `working` is released (v11 bug: retry never ran).
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
            setMessage('Resuming Auto Update...');
            setTimeout(run, 600);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
