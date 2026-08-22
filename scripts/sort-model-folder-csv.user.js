// ==UserScript==
// @name         Sort Model - Folder CSV Export/Import
// @namespace    homworks-branddgoods-csv
// @version      2.1
// @description  Capture a folder's brandGoods list, export obsBrandGoodId+name+topNumber to CSV, edit the sort model offline, then re-import the CSV to preview and push the update to the server.
// @match        *://*.homworksstudio.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[Sort Model] script loaded on', location.href);

  const LIST_URL_PATTERN = /\/gateway\/bgs\/custom\/library\/category\/brandgood\/list/i;
  const TOP_UPDATE_URL = `${location.origin}/gateway/bgs/brandgood/top`;

  let lastCapture = null; // { totalCount, brandGoods: [...], customLibraryId, library, catId }

  function safeParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function handleCapturedResponse(url, text) {
    if (!LIST_URL_PATTERN.test(url)) return;
    const json = safeParseJson(text);
    if (json && Array.isArray(json.brandGoods)) {
      let catId = '', customLibraryId = '';
      try {
        const u = new URL(url, location.origin);
        catId = u.searchParams.get('catid') || '';
        customLibraryId = u.searchParams.get('clibid') || '';
      } catch (e) {}
      const library = new URLSearchParams(location.search).get('lib') || '';
      lastCapture = { ...json, catId, customLibraryId, library };
      setStatus(`Captured folder: ${json.brandGoods.length} item(s), totalCount ${json.totalCount}.`);
    }
  }

  // --- Hook fetch ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : (req && req.url) || '';
    return origFetch.apply(this, args).then((res) => {
      if (LIST_URL_PATTERN.test(url)) {
        res
          .clone()
          .text()
          .then((text) => handleCapturedResponse(url, text))
          .catch(() => {});
      }
      return res;
    });
  };

  // --- Hook XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__csvCaptureUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (this.__csvCaptureUrl) {
        handleCapturedResponse(this.__csvCaptureUrl, this.responseText);
      }
    });
    return origSend.apply(this, args);
  };

  // --- CSV helpers ---
  function csvEscape(value) {
    const s = value === undefined || value === null ? '' : String(value);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // customLibraryId/library/catId ride along on every row (same folder-level
  // values repeated) so the CSV is self-contained, like the batch-update
  // script's per-row Product serial number — re-importing weeks later, in a
  // fresh tab, works without first re-clicking the folder in the sidebar to
  // repopulate lastCapture.
  function toCsv(rows) {
    const header = ['obsBrandGoodId', 'brandGoodId', 'name', 'topNumber', 'customLibraryId', 'library', 'catId'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.obsBrandGoodId), csvEscape(r.brandGoodId), csvEscape(r.name), csvEscape(r.topNumber),
          csvEscape(r.customLibraryId), csvEscape(r.library), csvEscape(r.catId),
        ].join(',')
      );
    }
    return lines.join('\r\n');
  }

  function parseCsv(text) {
    const rows = [];
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
    if (lines.length === 0) return rows;
    const header = splitCsvLine(lines[0]).map((h) => h.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      if (cells.length === 1 && cells[0] === '') continue;
      const row = {};
      header.forEach((h, idx) => (row[h] = cells[idx] !== undefined ? cells[idx] : ''));
      rows.push(row);
    }
    return rows;
  }

  function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          out.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
    }
    out.push(cur);
    return out;
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // --- UI panel ---
  let statusEl;
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; top: 100px; right: 20px; z-index: 999999;
      background: #1f2430; color: #e6e6e6; font: 12px/1.4 -apple-system, Segoe UI, Arial, sans-serif;
      border-radius: 8px; padding: 12px; width: 260px; box-shadow: 0 4px 16px rgba(0,0,0,.35);
    `;

    const reopenBtn = document.createElement('button');
    reopenBtn.textContent = 'Sort Model';
    reopenBtn.style.cssText = `
      position: fixed; top: 100px; right: 20px; z-index: 999999;
      background: #3b4a63; color:#fff; border:none; border-radius:6px;
      padding:8px 12px; font: 12px/1.4 -apple-system, Segoe UI, Arial, sans-serif;
      cursor:pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35); display:none;
    `;
    reopenBtn.onclick = () => {
      reopenBtn.style.display = 'none';
      panel.style.display = 'block';
    };
    document.body.appendChild(reopenBtn);

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';

    const title = document.createElement('div');
    title.textContent = 'Sort Model';
    title.style.cssText = 'font-weight:600; font-size:13px;';
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:4px;';

    const body = document.createElement('div');

    const minimizeBtn = document.createElement('button');
    minimizeBtn.textContent = '−';
    minimizeBtn.title = 'Minimize';
    styleIconButton(minimizeBtn);
    minimizeBtn.onclick = () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      minimizeBtn.textContent = collapsed ? '−' : '+';
    };
    controls.appendChild(minimizeBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    styleIconButton(closeBtn);
    closeBtn.onclick = () => {
      panel.style.display = 'none';
      reopenBtn.style.display = 'block';
    };
    controls.appendChild(closeBtn);

    header.appendChild(controls);
    panel.appendChild(header);
    panel.appendChild(body);

    statusEl = document.createElement('div');
    statusEl.textContent = 'Click a folder in the sidebar to capture its items.';
    statusEl.style.cssText = 'margin-bottom:10px; color:#9aa4b2; min-height: 32px;';
    body.appendChild(statusEl);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export Sort Model CSV';
    styleButton(exportBtn);
    exportBtn.onclick = () => {
      if (!lastCapture || !Array.isArray(lastCapture.brandGoods) || lastCapture.brandGoods.length === 0) {
        setStatus('No folder captured yet. Click a folder first.');
        return;
      }
      const rows = lastCapture.brandGoods.map((g) => ({
        obsBrandGoodId: g.obsBrandGoodId,
        brandGoodId: g.brandGoodId,
        name: g.name,
        topNumber: g.topNumber || '',
        customLibraryId: lastCapture.customLibraryId || '',
        library: lastCapture.library || '',
        catId: lastCapture.catId || '',
      }));
      const csv = toCsv(rows);
      downloadText(`sort-model-${Date.now()}.csv`, csv, 'text/csv');
      setStatus(`Exported ${rows.length} row(s) to CSV.`);
    };
    body.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import Sort Model CSV';
    styleButton(importBtn);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.csv';
    fileInput.style.display = 'none';
    importBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rows = parseCsv(String(reader.result));
        showPreview(rows);
        setStatus(`Parsed ${rows.length} row(s) from CSV.`);
      };
      reader.readAsText(file);
    };
    body.appendChild(importBtn);
    body.appendChild(fileInput);

    const previewWrap = document.createElement('div');
    previewWrap.style.cssText = 'margin-top:10px; max-height: 240px; overflow:auto; display:none;';
    body.appendChild(previewWrap);

    function groupByTopNumber(rows) {
      const groups = new Map();
      rows.forEach((r) => {
        const number = String(Number(r.topNumber) || 0);
        if (!groups.has(number)) groups.set(number, []);
        groups.get(number).push(r);
      });
      return groups;
    }

    // Prefers the folder context carried on the imported rows themselves
    // (customLibraryId/library/catId columns) — falls back to lastCapture
    // only for a CSV exported before those columns existed.
    function resolveFolderContext(rows) {
      const fromRow = rows.find((r) => r.customLibraryId || r.catId);
      if (fromRow) {
        return {
          customLibraryId: fromRow.customLibraryId || '',
          library: fromRow.library || '',
          catId: fromRow.catId || '',
        };
      }
      if (lastCapture) {
        return {
          customLibraryId: lastCapture.customLibraryId || '',
          library: lastCapture.library || '',
          catId: lastCapture.catId || '',
        };
      }
      return null;
    }

    async function sendTopUpdate(number, brandGoodIds, ctx) {
      const body = {
        number,
        brandGoodIds,
        customLibraryId: ctx.customLibraryId,
        library: ctx.library,
        catId: ctx.catId,
      };
      const res = await fetch(TOP_UPDATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json().catch(() => ({}));
    }

    function showPreview(rows) {
      previewWrap.innerHTML = '';
      previewWrap.style.display = rows.length ? 'block' : 'none';

      const ctx = resolveFolderContext(rows);
      if (!ctx) {
        const warn = document.createElement('div');
        warn.textContent = 'No folder context in this CSV or in memory — click a folder in the sidebar once, or re-export a CSV with the customLibraryId/catId columns.';
        warn.style.cssText = 'color:#e0a44c; margin-bottom:6px;';
        previewWrap.appendChild(warn);
      }

      const groups = groupByTopNumber(rows);

      const table = document.createElement('table');
      table.style.cssText = 'width:100%; border-collapse:collapse; font-size:11px;';
      const head = document.createElement('tr');
      ['sort number', 'items'].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'text-align:left; border-bottom:1px solid #3a4150; padding:3px;';
        head.appendChild(th);
      });
      table.appendChild(head);
      groups.forEach((groupRows, number) => {
        const tr = document.createElement('tr');
        const tdNum = document.createElement('td');
        tdNum.textContent = number;
        tdNum.style.cssText = 'padding:3px; border-bottom:1px solid #2a3140; vertical-align:top;';
        const tdItems = document.createElement('td');
        tdItems.textContent = groupRows.map((r) => r.name).join(', ');
        tdItems.style.cssText = 'padding:3px; border-bottom:1px solid #2a3140;';
        tr.appendChild(tdNum);
        tr.appendChild(tdItems);
        table.appendChild(tr);
      });
      previewWrap.appendChild(table);

      const sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send Sort Model to Server';
      styleButton(sendBtn);
      sendBtn.style.marginTop = '8px';
      sendBtn.style.background = '#a63b3b';
      sendBtn.onclick = async () => {
        if (!ctx) {
          setStatus('No folder context available. Click the folder in the sidebar once, or re-export a CSV that includes customLibraryId/catId, then re-import.');
          return;
        }
        const totalItems = rows.length;
        const groupCount = groups.size;
        const ok = confirm(
          `This will send ${groupCount} update request(s) covering ${totalItems} item(s) to the live server (folder: catId=${ctx.catId}). Continue?`
        );
        if (!ok) return;
        let done = 0;
        let failed = 0;
        for (const [number, groupRows] of groups) {
          const ids = groupRows.map((r) => r.obsBrandGoodId).filter(Boolean);
          if (ids.length === 0) continue;
          try {
            await sendTopUpdate(number, ids, ctx);
            done++;
            setStatus(`Sent ${done}/${groupCount} group(s)...`);
          } catch (e) {
            failed++;
            console.error('[Sort Model] update failed for number', number, e);
          }
        }
        setStatus(`Done. ${done} group(s) succeeded, ${failed} failed.`);
      };
      previewWrap.appendChild(sendBtn);

      const jsonBtn = document.createElement('button');
      jsonBtn.textContent = 'Copy grouped payloads as JSON';
      styleButton(jsonBtn);
      jsonBtn.style.marginTop = '6px';
      jsonBtn.onclick = () => {
        const payload = [...groups].map(([number, groupRows]) => ({
          number,
          brandGoodIds: groupRows.map((r) => r.obsBrandGoodId),
          customLibraryId: ctx ? ctx.customLibraryId : '',
          library: ctx ? ctx.library : '',
          catId: ctx ? ctx.catId : '',
        }));
        navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
          setStatus('JSON payload copied to clipboard.');
        });
      };
      previewWrap.appendChild(jsonBtn);
    }

    document.body.appendChild(panel);
  }

  function styleButton(btn) {
    btn.style.cssText = `
      display:block; width:100%; margin-top:6px; padding:6px 8px;
      background:#3b4a63; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px;
    `;
    btn.onmouseenter = () => (btn.style.background = '#4b5f7f');
    btn.onmouseleave = () => (btn.style.background = '#3b4a63');
  }

  function styleIconButton(btn) {
    btn.style.cssText = `
      width:20px; height:20px; line-height:18px; padding:0; text-align:center;
      background:#3b4a63; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:13px;
    `;
    btn.onmouseenter = () => (btn.style.background = '#4b5f7f');
    btn.onmouseleave = () => (btn.style.background = '#3b4a63');
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildPanel);
    } else {
      buildPanel();
    }
  }

  init();
})();
