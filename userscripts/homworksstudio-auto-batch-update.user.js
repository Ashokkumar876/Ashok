// ==UserScript==
// @name         Homworks Studio - Auto Batch Update Parts
// @namespace    homworksstudio-auto-batch-update
// @version      3.0
// @description  Click once to automatically repeat Select All + Update Part on the CPM model batch-update list page until every remaining item has been updated (count reaches 0). Polls for real completion instead of using fixed delays, so it moves to the next batch as soon as the backend finishes.
// @match        https://www.homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @match        https://homworksstudio.com/pub/tool/cpm/modelbatchudpate/list*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // NOTE: An earlier version of this script tried a "one-shot" mode that called
  // the modelinstance + operation/record APIs directly, skipping the UI. That
  // doesn't actually work: the real "Update Part" click also runs the site's own
  // client-side logic (which recomputes/saves the model's new version) — the two
  // network calls alone only fetch data and write an audit-log entry, so items
  // never leave the "remaining" list. Real clicks are required, so this script
  // automates the real clicks in a loop instead.
  const POLL_INTERVAL_MS = 400;
  const ELEMENT_WAIT_TIMEOUT_MS = 20000;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // After clicking "Update Part" the site does real server-side rendering per item,
  // which can take a while. Instead of a fixed guessed delay, poll the count and
  // move on the instant it actually changes — this is as fast as the backend allows.
  const PROCESSING_POLL_INTERVAL_MS = 2500;
  const MAX_BATCH_WAIT_MS = 8 * 60 * 1000; // safety cap per batch (8 min)

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

  // Polls the count (refreshing the list each time) until it actually drops below
  // `totalBefore`, or until MAX_BATCH_WAIT_MS elapses. Returns the latest counts.
  async function waitForBatchToFinish(totalBefore) {
    const start = Date.now();
    while (Date.now() - start < MAX_BATCH_WAIT_MS) {
      if (!running) return parseSelectedCounts();
      await sleep(PROCESSING_POLL_INTERVAL_MS);
      await clickRefreshListIfPresent();
      const counts = parseSelectedCounts();
      if (counts && counts.total !== totalBefore) {
        return counts;
      }
    }
    return parseSelectedCounts();
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
    log('Clicked. Waiting for the site to finish processing this batch (real server-side rendering — moving on the instant it completes)...');
    const after = await waitForBatchToFinish(before ? before.total : -1);

    if (isFinished(after)) {
      finish('All parts have been updated (remaining total reached 0).');
      return;
    }

    if (before && after && after.total === before.total) {
      handleFailure(`No progress after waiting ${Math.round(MAX_BATCH_WAIT_MS / 60000)} min on this batch — it may still be processing.`);
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
      controlButton.textContent = 'Start Auto Update (runs until 0)';
      controlButton.style.background = '#2563eb';
    }
  }

  function addControlButton() {
    if (document.getElementById('auto-batch-update-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'auto-batch-update-btn';
    btn.textContent = 'Start Auto Update (runs until 0)';
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
