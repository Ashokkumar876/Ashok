// ==UserScript==
// @name         Homworks Studio - Auto Batch Update Parts
// @namespace    homworksstudio-auto-batch-update
// @version      2.0
// @description  Updates all remaining items on the CPM model batch-update list page. Adds a fast "One-Shot Update All" (direct API calls) and a fallback "Auto Update (Click Loop)" that simulates Select All + Update Part clicks.
// @match        https://www.homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @match        https://homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const AFTER_UPDATE_DELAY_MS = 3500;   // give the "Update Part" request time to finish before checking state again
  const POLL_INTERVAL_MS = 400;
  const ELEMENT_WAIT_TIMEOUT_MS = 20000;
  const MAX_CONSECUTIVE_FAILURES = 3;

  // --- One-shot (direct API) settings ---
  // toolType matches the currently selected tab: "cabinet" = Kitchen & Bath.
  // If you run this on Custom Furniture / Doors & Windows, check the Network tab
  // for the toolType value used by that tab's "oldversion" request and update this.
  const TOOL_TYPE = 'cabinet';
  // Captured from a real "Update Part" click — this project seems to log a fixed
  // operator id rather than the logged-in user's id. Verify against a fresh
  // network capture if operation/record calls start failing.
  const OPERATOR_ID = 19;
  const ONE_SHOT_BATCH_SIZE = 30;   // items per API batch
  const ONE_SHOT_BATCH_DELAY_MS = 600;

  let running = false;
  let consecutiveFailures = 0;
  let controlButton = null;
  let oneShotButton = null;
  let oneShotRunning = false;

  function log(...args) {
    console.log('[AutoBatchUpdate]', ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(conditionFn, timeoutMs = ELEMENT_WAIT_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  // Finds the smallest (leaf-most) element whose own text exactly matches `text`.
  function findClickableByExactText(text) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    let best = null;
    while (node) {
      if (node.children.length === 0 && node.textContent.trim() === text) {
        best = node;
        break;
      }
      node = walker.nextNode();
    }
    if (best) return best;
    // fall back to a container whose direct text (ignoring nested elements) matches
    const all = Array.from(document.querySelectorAll('button, a, div, span, label'));
    return all.find((el) => el.textContent.trim() === text) || null;
  }

  function getClickTarget(el) {
    // Prefer clicking an ancestor button/role=button if the text node itself isn't clickable.
    const clickableAncestor = el.closest('button, [role="button"], a');
    return clickableAncestor || el;
  }

  function parseSelectedCounts() {
    // Actual markup: <div class="select-all-checkbox">...<div class="selected-num">Selected 9/100</div></div>
    const countEl = document.querySelector('.select-all-checkbox .selected-num');
    const text = countEl ? countEl.textContent : document.body.innerText;
    const match = text.match(/Selected\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return null;
    return { selected: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  }

  function findSelectAllCheckbox() {
    // Actual markup: <div class="select-all-checkbox"><label class="tui-control tui-checkbox">
    //   <input type="checkbox"><span class="tui-control-indicator"></span>Select All</label>...</div>
    const checkbox = document.querySelector('.select-all-checkbox input[type="checkbox"]');
    if (checkbox) return checkbox;
    // Fallback in case the page markup changes.
    const label = findClickableByExactText('Select All');
    if (label) {
      const container = label.closest('div, label, span') || label.parentElement;
      const fallbackCheckbox =
        container?.querySelector('input[type="checkbox"]') ||
        container?.parentElement?.querySelector('input[type="checkbox"]');
      if (fallbackCheckbox) return fallbackCheckbox;
    }
    return document.querySelector('input[type="checkbox"]');
  }

  function isSelectAllChecked(checkbox) {
    if (checkbox.checked) return true;
    // The tui-checkbox component also toggles a class on the wrapping <label>.
    const label = checkbox.closest('label');
    return !!label && label.classList.contains('tui-checked');
  }

  function findUpdatePartButton() {
    // Actual markup: <button class="tui-btn tui-btn--primary ...">Update Part</button>
    const primaryButtons = Array.from(document.querySelectorAll('button.tui-btn--primary'));
    const byClass = primaryButtons.find((btn) => btn.textContent.trim() === 'Update Part');
    if (byClass) return byClass;
    const el = findClickableByExactText('Update Part');
    return el ? getClickTarget(el) : null;
  }

  function findRefreshListButton() {
    // Actual markup: <div class="refresh-button"><button class="tui-btn tui-btn--secondary ...">Refresh List</button></div>
    const byClass = document.querySelector('.refresh-button button');
    if (byClass) return byClass;
    const el = findClickableByExactText('Refresh List');
    return el ? getClickTarget(el) : null;
  }

  // Auto-accept any confirm() dialog the click might trigger (e.g. "Are you sure?").
  function withAutoConfirm(fn) {
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      return fn();
    } finally {
      window.confirm = originalConfirm;
    }
  }

  async function ensureSelectAll() {
    const checkbox = await waitFor(findSelectAllCheckbox);
    if (!checkbox) {
      log('Could not find the "Select All" checkbox.');
      return false;
    }
    if (!isSelectAllChecked(checkbox)) {
      checkbox.click();
      log('Clicked "Select All".');
      await sleep(300);
    } else {
      log('"Select All" was already checked.');
    }
    return true;
  }

  async function clickUpdatePart() {
    const btn = await waitFor(findUpdatePartButton);
    if (!btn) {
      log('Could not find the "Update Part" button.');
      return false;
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      log('"Update Part" button is disabled — nothing selected or no items left.');
      return false;
    }
    withAutoConfirm(() => btn.click());
    log('Clicked "Update Part".');
    return true;
  }

  async function clickRefreshListIfPresent() {
    const btn = findRefreshListButton();
    if (btn) {
      btn.click();
      log('Clicked "Refresh List".');
      await sleep(1000);
    }
  }

  function isFinished(counts) {
    if (!counts) return false;
    return counts.total === 0;
  }

  async function runCycle() {
    if (!running) return;

    const before = parseSelectedCounts();
    if (before) log(`Status before cycle: Selected ${before.selected}/${before.total}`);

    if (isFinished(before)) {
      finish('All parts have been updated (remaining total reached 0).');
      return;
    }

    const selectedOk = await ensureSelectAll();
    if (!selectedOk) {
      handleFailure('Failed to select all items.');
      return;
    }

    const updatedOk = await clickUpdatePart();
    if (!updatedOk) {
      // Nothing to update might mean we're already done — recheck counts before giving up.
      const recheck = parseSelectedCounts();
      if (isFinished(recheck)) {
        finish('All parts have been updated (remaining total reached 0).');
        return;
      }
      handleFailure('Failed to click "Update Part".');
      return;
    }

    consecutiveFailures = 0;
    await sleep(AFTER_UPDATE_DELAY_MS);
    await clickRefreshListIfPresent();
    await sleep(800);

    const after = parseSelectedCounts();
    if (isFinished(after)) {
      finish('All parts have been updated (remaining total reached 0).');
      return;
    }

    if (running) {
      setTimeout(runCycle, POLL_INTERVAL_MS);
    }
  }

  function handleFailure(reason) {
    consecutiveFailures += 1;
    log(`${reason} (failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stop(`Stopped after repeated failures: ${reason}`);
      return;
    }
    setTimeout(runCycle, POLL_INTERVAL_MS * 3);
  }

  function finish(message) {
    log(message);
    stop(message, true);
  }

  function stop(message, success = false) {
    running = false;
    updateButtonUi();
    if (message) {
      alert(`Auto Batch Update: ${message}`);
    }
  }

  // ---------------------------------------------------------------------
  // One-shot mode: call the underlying APIs directly instead of clicking
  // through the UI in batches of ~9 with multi-second waits.
  // ---------------------------------------------------------------------

  function getLibraryIdFromUrl() {
    return new URLSearchParams(window.location.search).get('extendlibraryid');
  }

  function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  async function fetchOldVersionPage(libraryId, page) {
    const url = `/editor/api/site/model/oldversion?toolType=${encodeURIComponent(TOOL_TYPE)}&page=${page}&libraryId=${encodeURIComponent(libraryId)}`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'editor-locale': 'en_IN',
        'x-qh-locale': 'en_IN',
        'x-qh-site': 'coohom',
      },
    });
    if (!res.ok) throw new Error(`oldversion request failed: ${res.status}`);
    return res.json();
  }

  async function collectAllRemainingIds(libraryId) {
    const ids = [];
    const seen = new Set();
    let page = 0;
    let totalPage = 1;
    do {
      const data = await fetchOldVersionPage(libraryId, page);
      const items = Array.isArray(data.result) ? data.result : [];
      for (const item of items) {
        if (item.obsBrandGoodId && !seen.has(item.obsBrandGoodId)) {
          seen.add(item.obsBrandGoodId);
          ids.push(item.obsBrandGoodId);
        }
      }
      totalPage = typeof data.totalPage === 'number' && data.totalPage > 0 ? data.totalPage : 1;
      page += 1;
    } while (page < totalPage);
    return ids;
  }

  async function submitModelInstanceBatch(ids) {
    const res = await fetch('/editortask/editordata/modelinstance', {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'content-type': 'application/json;charset=UTF-8',
        'editor-locale': 'en_IN',
        'x-qh-locale': 'en_IN',
        'x-qh-site': 'coohom',
      },
      body: JSON.stringify({ obsBrandGoodIds: ids }),
    });
    if (!res.ok) throw new Error(`modelinstance request failed: ${res.status}`);
  }

  async function submitOperationRecordBatch(ids) {
    const now = Date.now();
    const payload = ids.map((obsBrandGoodId) => ({
      obsBrandGoodId,
      operatorId: OPERATOR_ID,
      timestamp: now,
      content: 'Update Part',
    }));
    const res = await fetch('/editor/api/site/brandgood/operation/record', {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'editor-locale': 'en_IN',
        'x-qh-locale': 'en_IN',
        'x-qh-site': 'coohom',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`operation/record request failed: ${res.status}`);
  }

  function updateOneShotButtonUi(text, background) {
    if (!oneShotButton) return;
    oneShotButton.textContent = text;
    oneShotButton.style.background = background;
  }

  async function runOneShotUpdate() {
    if (oneShotRunning) return;
    oneShotRunning = true;
    updateOneShotButtonUi('Updating...', '#6b7280');

    try {
      const libraryId = getLibraryIdFromUrl();
      if (!libraryId) {
        throw new Error('Could not find "extendlibraryid" in the page URL.');
      }

      log('One-shot: fetching full list of items needing update...');
      const allIds = await collectAllRemainingIds(libraryId);
      log(`One-shot: found ${allIds.length} item(s) to update.`);

      if (allIds.length === 0) {
        alert('One-Shot Update: nothing to update — list is already empty.');
        return;
      }

      const batches = chunkArray(allIds, ONE_SHOT_BATCH_SIZE);
      let done = 0;
      for (const batch of batches) {
        await submitModelInstanceBatch(batch);
        await submitOperationRecordBatch(batch);
        done += batch.length;
        log(`One-shot: updated ${done}/${allIds.length}`);
        updateOneShotButtonUi(`Updating ${done}/${allIds.length}...`, '#6b7280');
        await sleep(ONE_SHOT_BATCH_DELAY_MS);
      }

      // Verify.
      const remaining = await collectAllRemainingIds(libraryId);
      await clickRefreshListIfPresent();

      if (remaining.length === 0) {
        alert(`One-Shot Update finished: updated ${allIds.length} item(s).`);
      } else {
        alert(
          `One-Shot Update: submitted ${allIds.length} item(s), but ${remaining.length} still show as remaining. ` +
            'Click "One-Shot Update All" again to retry those.'
        );
      }
    } catch (err) {
      log('One-shot update failed:', err);
      alert(`One-Shot Update failed: ${err.message}\nCheck the console for details.`);
    } finally {
      oneShotRunning = false;
      updateOneShotButtonUi('One-Shot Update All', '#059669');
    }
  }

  function addOneShotButton() {
    if (document.getElementById('one-shot-update-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'one-shot-update-btn';
    btn.textContent = 'One-Shot Update All';
    Object.assign(btn.style, {
      position: 'fixed',
      top: '54px',
      right: '10px',
      zIndex: 999999,
      padding: '10px 16px',
      background: '#059669',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px',
      fontFamily: 'sans-serif',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', runOneShotUpdate);
    document.body.appendChild(btn);
    oneShotButton = btn;
  }

  function updateButtonUi() {
    if (!controlButton) return;
    if (running) {
      controlButton.textContent = 'Stop Auto Update';
      controlButton.style.background = '#dc2626';
    } else {
      controlButton.textContent = 'Auto Update (Click Loop)';
      controlButton.style.background = '#2563eb';
    }
  }

  function addControlButton() {
    if (document.getElementById('auto-batch-update-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'auto-batch-update-btn';
    btn.textContent = 'Auto Update (Click Loop)';
    Object.assign(btn.style, {
      position: 'fixed',
      top: '10px',
      right: '10px',
      zIndex: 999999,
      padding: '10px 16px',
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px',
      fontFamily: 'sans-serif',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    });

    btn.addEventListener('click', () => {
      if (!running) {
        running = true;
        consecutiveFailures = 0;
        updateButtonUi();
        log('Starting auto update loop...');
        runCycle();
      } else {
        log('Stopping auto update loop (user requested).');
        running = false;
        updateButtonUi();
      }
    });

    document.body.appendChild(btn);
    controlButton = btn;
  }

  window.addEventListener('load', () => {
    setTimeout(() => {
      addControlButton();
      addOneShotButton();
    }, 1000);
  });
})();
