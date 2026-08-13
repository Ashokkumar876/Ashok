// ==UserScript==
// @name         Count Param: Int → Float
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Batch-update obsBrandGoodIds: sets the 'count' input param's valueType from int to float and renames its displayName to QTY.
// @match        https://beta.kujiale.com/vc/modeleditor/new*
// @match        https://www.kujiale.com/vc/modeleditor/new*
// @match        https://www.homworksstudio.com/pub/tool/cpm/modeleditor/new*
// @match        https://prod-test-sg.homworksstudio.com/pub/tool/cpm/modeleditor/new*
// @match        https://www.homworksstudio.com/pub/saas/brandgoods/custom/list*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---------- baseUrl resolution ----------
    const origin = window.location.origin;
    const hostname = window.location.hostname;
    let baseUrl = '';
    if (hostname === 'beta.kujiale.com' || hostname === 'www.kujiale.com') {
        baseUrl = origin;
    } else if (hostname.endsWith('.homworksstudio.com') || hostname === 'homworksstudio.com') {
        baseUrl = origin;
    } else {
        baseUrl = 'https://beta.kujiale.com';
    }

    // ---------- the only transform this script does ----------
    function query(json) {
        if (json && Array.isArray(json.inputs)) {
            json.inputs.forEach(function (item) {
                if (item.paramName === 'count') {
                    item.valueType = 'float';
                    item.displayName = 'QTY';
                }
            });
        }
        return json;
    }

    // ---------- core per-ID logic: GET -> transform -> POST ----------
    async function processOneId(id) {
        const urlGet = `${baseUrl}/editor/api/site/editordata?obsbrandgoodid=${encodeURIComponent(id)}&doupdate=true&tooltype=wardrobe`;
        const getResp = await fetch(urlGet, {
            method: 'GET',
            credentials: 'include',
            headers: { accept: '*/*', 'editor-locale': 'zh_CN' },
        });
        if (!getResp.ok) {
            return { id, ok: false, message: `GET failed, status ${getResp.status}` };
        }
        const jsonData = await getResp.json();
        const editorData = jsonData.editorData || {};
        const updated = query(editorData);
        const postBody = {
            editorData: updated,
            paramModelInfo: jsonData.paramModelInfo || {},
        };
        const postResp = await fetch(`${baseUrl}/editor/api/site/editordata`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'text/plain;utf-8',
                accept: '*/*',
                'editor-locale': 'zh_CN',
            },
            body: JSON.stringify(postBody),
        });
        if (!postResp.ok) {
            return { id, ok: false, message: `POST failed, status ${postResp.status}` };
        }
        return { id, ok: true };
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ===== Position/open state persistence (so the panel stays put across page refreshes) =====
    const POS_KEY = '__countParamPanelPos';
    const OPEN_KEY = '__countParamPanelOpen';

    function loadPosition() {
        try {
            const pos = JSON.parse(localStorage.getItem(POS_KEY));
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') return pos;
        } catch (e) { /* ignore malformed/missing state */ }
        return null;
    }
    function savePosition(left, top) {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left, top })); } catch (e) { /* storage unavailable */ }
    }
    function loadOpen() {
        return localStorage.getItem(OPEN_KEY) === '1';
    }
    function saveOpen(open) {
        try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    }

    // ===== UI =====
    function createToggleButton(onOpen) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '🔢 Count → Float';
        btn.title = 'Open Count Param: Int → Float';
        Object.assign(btn.style, {
            position: 'fixed', top: '20px', right: '330px', height: '32px', padding: '0 16px',
            borderRadius: '16px', border: 'none', background: '#722ed1', color: '#fff',
            fontSize: '13px', fontWeight: 'bold', fontFamily: 'Arial, Helvetica, sans-serif',
            cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.25)', zIndex: 999999,
        });
        btn.addEventListener('click', onOpen);
        document.body.appendChild(btn);
        return btn;
    }

    function createPanel(onClose) {
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed', top: '58px', right: '330px', width: '340px',
            display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #d9d9d9',
            borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,0.18)', zIndex: 999999,
            fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '13px', overflow: 'hidden',
            boxSizing: 'border-box',
        });

        // Restore last-dragged position so the panel doesn't jump back to the corner on every refresh.
        const savedPos = loadPosition();
        if (savedPos) {
            panel.style.left = savedPos.left + 'px';
            panel.style.top = savedPos.top + 'px';
            panel.style.right = 'auto';
        }

        const header = document.createElement('div');
        Object.assign(header.style, {
            background: '#722ed1', color: '#fff', padding: '8px 10px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between', userSelect: 'none',
        });

        const moveHandle = document.createElement('span');
        moveHandle.textContent = '⠿ Count Param: Int → Float';
        moveHandle.title = 'Drag to move';
        Object.assign(moveHandle.style, { fontWeight: 'bold', cursor: 'grab' });
        header.appendChild(moveHandle);

        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close (reopen from the button)';
        closeBtn.style.cursor = 'pointer';
        closeBtn.onclick = () => { panel.remove(); onClose(); };
        header.appendChild(closeBtn);

        panel.appendChild(header);

        const body = document.createElement('div');
        Object.assign(body.style, { padding: '14px', boxSizing: 'border-box' });

        const label = document.createElement('label');
        label.textContent = 'Enter obsBrandGoodId(s), one per line:';
        label.style.display = 'block';
        label.style.marginBottom = '4px';

        const textarea = document.createElement('textarea');
        Object.assign(textarea.style, {
            width: '100%', height: '120px', fontFamily: 'monospace', fontSize: '12px',
            marginBottom: '10px', boxSizing: 'border-box',
        });
        textarea.placeholder = 'e.g.\n3FO3G284DAYW\nABCD1234EFGH';

        const runBtn = document.createElement('button');
        runBtn.textContent = 'Run';
        Object.assign(runBtn.style, {
            padding: '6px 14px', backgroundColor: '#722ed1', color: '#fff',
            border: 'none', borderRadius: '4px', cursor: 'pointer',
        });

        const progress = document.createElement('div');
        Object.assign(progress.style, { marginTop: '10px', color: '#333', whiteSpace: 'pre-wrap' });

        body.appendChild(label);
        body.appendChild(textarea);
        body.appendChild(runBtn);
        body.appendChild(progress);
        panel.appendChild(body);
        document.body.appendChild(panel);
        makeDraggable(panel, moveHandle);

        runBtn.addEventListener('click', async () => {
            const ids = textarea.value
                .split(/[\n,]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            if (ids.length === 0) {
                alert('Please enter at least one obsBrandGoodId.');
                return;
            }
            runBtn.disabled = true;
            runBtn.textContent = 'Running...';
            const results = [];
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                progress.textContent = `Processing ${i + 1}/${ids.length}: ${id}`;
                try {
                    results.push(await processOneId(id));
                } catch (e) {
                    results.push({ id, ok: false, message: e.message || String(e) });
                }
                await delay(500);
            }
            const failed = results.filter((r) => !r.ok);
            progress.textContent =
                `Done. ${results.length - failed.length}/${results.length} succeeded.` +
                (failed.length ? `\n\nFailed:\n${failed.map((f) => `${f.id}: ${f.message}`).join('\n')}` : '');
            runBtn.disabled = false;
            runBtn.textContent = 'Run';
        });

        return panel;
    }

    function makeDraggable(panel, handle) {
        let dragging = false, offsetX = 0, offsetY = 0;
        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            handle.style.cursor = 'grabbing';
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
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = 'grab';
            savePosition(parseInt(panel.style.left, 10), parseInt(panel.style.top, 10));
        });
    }

    function init() {
        let panel = null;
        let toggleBtn = null;

        function openPanel() {
            if (toggleBtn) { toggleBtn.remove(); toggleBtn = null; }
            panel = createPanel(closePanel);
            saveOpen(true);
        }
        function closePanel() {
            if (panel) { panel.remove(); panel = null; }
            toggleBtn = createToggleButton(openPanel);
            saveOpen(false);
        }

        // Starts as just the small button unless the user had it open when they last left.
        if (loadOpen()) openPanel(); else closePanel();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
