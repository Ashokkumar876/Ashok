// ==UserScript==
// @name         Homworks Studio - Auto Batch Update Parts
// @namespace    homworksstudio-auto-batch-update
// @version      1.1
// @description  Repeatedly clicks "Select All" then "Update Part" on the CPM model batch-update list page until every remaining item has been updated.
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

  let running = false;
  let consecutiveFailures = 0;
  let controlButton = null;

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
    const match = document.body.innerText.match(/Selected\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return null;
    return { selected: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  }

  function findSelectAllCheckbox() {
    const label = findClickableByExactText('Select All');
    if (label) {
      const container = label.closest('div, label, span') || label.parentElement;
      const checkbox =
        container?.querySelector('input[type="checkbox"]') ||
        container?.parentElement?.querySelector('input[type="checkbox"]');
      if (checkbox) return checkbox;
    }
    return document.querySelector('input[type="checkbox"]');
  }

  function findUpdatePartButton() {
    const el = findClickableByExactText('Update Part');
    return el ? getClickTarget(el) : null;
  }

  function findRefreshListButton() {
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
    if (!checkbox.checked) {
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

  function updateButtonUi() {
    if (!controlButton) return;
    if (running) {
      controlButton.textContent = 'Stop Auto Update';
      controlButton.style.background = '#dc2626';
    } else {
      controlButton.textContent = 'Start Auto Update';
      controlButton.style.background = '#2563eb';
    }
  }

  function addControlButton() {
    if (document.getElementById('auto-batch-update-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'auto-batch-update-btn';
    btn.textContent = 'Start Auto Update';
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
    setTimeout(addControlButton, 1000);
  });
})();
