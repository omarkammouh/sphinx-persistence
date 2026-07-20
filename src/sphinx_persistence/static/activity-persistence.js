/**
 * Interactive-activity persistence (pluggable, zero-touch).
 *
 * The book has bespoke `{raw} html` Learning Activities (classify,
 * match, order, fill-the-gap quizzes, selection sandboxes, …). Each keeps the
 * reader's answer in PRIVATE JavaScript closure variables (`var assigned=[];
 * var checked=false;`) that no outside code can read, so data-manager.js (which
 * only sees native form controls) and the {question} adapter cannot persist them.
 *
 * Rather than inject a save/restore hook into every widget (which would scatter
 * persistence code across dozens of pages), this single file reconstructs a
 * activity's private state the only way possible from the outside: it RECORDS the
 * reader's real clicks inside an activity, and on reload REPLAYS them through the
 * activity's OWN event handlers. Replaying the clicks re-runs exactly the code the
 * reader triggered, so the closure state, the DOM, AND the graded result (the
 * trailing "Check" click is part of the sequence) all come back, with no edits
 * to any widget. Drop this file in, register it in _config.yml, and it works.
 *
 * Scope (auto-discovered, no markup needed):
 *   - Records trusted clicks on interactive controls (buttons / role=button /
 *     [onclick] / cursor:pointer elements) inside the article body.
 *   - The activity is keyed by the OUTERMOST `div[id]` wrapping the control (the
 *     author-given widget id, e.g. #bm). Content sections are <section> tags, so
 *     that outermost div[id] is always the widget wrapper, never a theme wrapper.
 *   - EXCLUDED automatically: native form controls (input/select/textarea/label
 *    , data-manager.js owns those), navigation links, the persistence toolbar,
 *     and any widget whose root contains a <canvas> (live simulations/games,
 *     whose run-state is ephemeral and not meaningful to persist).
 *   - The `persistence_activity_exclude_ids` Sphinx option is the single knob
 *     to skip specific widgets by root id.
 *
 * Storage: one key per widget, `abm_book_<pathname>__activity__<rootId>`, holding
 * the ordered click sequence. The `abm_book_` prefix means the existing
 * Export / Import / Reset flow (book-exporter.js + data-manager.js) already
 * covers activity progress with no extra code.
 */
(function () {
  'use strict';

  var CONFIG = window.sphinxPersistence || {};

  var PREFIX = 'abm_book_';
  var SAVE_DELAY = 400;          // debounce (ms) after a click before persisting
  var MAX_EVENTS = 400;          // cap the stored sequence per widget (storage guard)
  // Root ids to never persist (e.g. timed quiz-games). Configured via the
  // `persistence_activity_exclude_ids` Sphinx option (injected at build time).
  var EXCLUDE_IDS = CONFIG.activityExcludeIds || [];

  // Non-content regions whose clicks must never be recorded/replayed.
  var UI_EXCLUDE = '.article-header-buttons, #progress-buttons, .reset-dialog, ' +
    '.bd-sidebar, .bd-sidebar-primary, .bd-sidebar-secondary, nav, header, ' +
    '.prev-next-area, .bd-header-article';

  // Framework components OTHER scripts already own, or that are deliberately not
  // persisted, replaying clicks into these would fight the owning system:
  //   .multiple-choice / .short-answer -> teachbook-questions-persistence.js
  //   .sd-tab-set                      -> js/tabset-reset.js (reset to default on load)
  //   .sd-dropdown / details / summary / .toggle-button -> collapsibles (open-state
  //                                       is intentionally not persisted)
  //   .cell / .thebe                   -> live code cells (thebe-code-persistence.js)
  var FRAMEWORK_EXCLUDE = '.multiple-choice, .short-answer, .sd-tab-set, ' +
    '.sd-dropdown, details, summary, .toggle-button, .cell, .thebe';

  var sequences = new Map();     // rootId -> array of locators (in-memory mirror)
  var saveTimers = new Map();    // rootId -> debounce timer
  var replaying = false;         // true while we dispatch synthetic clicks

  function keyFor(rootId) {
    return PREFIX + window.location.pathname + '__activity__' + rootId;
  }

  // ---- element helpers ----------------------------------------------------

  function articleOf(el) {
    return el.closest('article, .bd-article, [role="main"], main');
  }

  /**
   * The activity root for a control = the OUTERMOST div[id] between it and the
   * article. Sections are <section> tags (not div), and there is no div[id]
   * wrapping the whole article, so this is reliably the author's activity div
   * (e.g. #bm), not an inner container (#bm-rows) and not a page wrapper.
   * Falls back to the innermost id'd ancestor (e.g. a <section id>) for the few
   * widgets that aren't wrapped in their own div[id] (e.g. an admonition
   * containing a "Count my score" button).
   */
  function activityRoot(el, article) {
    var outerDivId = null, innerAnyId = null, node = el;
    while (node && node !== article) {
      if (node.id) {
        if (!innerAnyId) innerAnyId = node;          // first (innermost) id seen
        if (node.tagName === 'DIV') outerDivId = node; // keep climbing -> outermost
      }
      node = node.parentElement;
    }
    return outerDivId || innerAnyId;
  }

  /**
   * The interactive control the reader actually clicked: an explicit control if
   * present, else the highest cursor:pointer element up to the root (covers
   * div/span "chips" and "tiles" that carry a click handler via addEventListener).
   * Returns null for clicks on non-interactive content (prose), which we ignore.
   */
  function controlOf(target, root) {
    var btn = target.closest('button, [role="button"], [onclick]');
    if (btn && root.contains(btn)) return btn;
    var node = target, top = null;
    while (node) {
      if (node.nodeType === 1) {
        try { if (window.getComputedStyle(node).cursor === 'pointer') top = node; } catch (e) { /* detached */ }
      }
      if (node === root) break;
      node = node.parentElement;
    }
    return top;
  }

  function normText(el) {
    var s = (el.textContent || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[✓✗»\-\s]+/, ''); // strip leading ✓ ✗ » marks
    return s.slice(0, 80).toLowerCase();
  }

  /** All elements in root with the same tag + normalized text, in document order. */
  function sameSigList(root, tag, text) {
    var out = [];
    var all = root.getElementsByTagName(tag);
    for (var i = 0; i < all.length; i++) {
      if (normText(all[i]) === text) out.push(all[i]);
    }
    return out;
  }

  function childIndexPath(el, root) {
    var path = [], node = el;
    while (node && node !== root) {
      var parent = node.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return node === root ? path : null;
  }

  function byPath(root, path) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
      if (!node) return null;
      node = node.children[path[i]];
    }
    return node || null;
  }

  /**
   * A locator that must survive re-render AND on-load shuffles: id (best),
   * tag+text+occurrence (survives reshuffled pools, since text is stable), and a
   * structural child-index path (fallback for icon-only / textless controls).
   */
  function locatorOf(el, root) {
    var loc = { t: el.tagName };
    if (el.id) loc.id = el.id;
    var x = normText(el);
    if (x) {
      loc.x = x;
      loc.o = sameSigList(root, el.tagName, x).indexOf(el);
    }
    var p = childIndexPath(el, root);
    if (p) loc.p = p;
    return loc;
  }

  function resolve(loc, root) {
    if (loc.id) {
      var byId = document.getElementById(loc.id);
      if (byId && root.contains(byId)) return byId;
    }
    if (loc.x != null && loc.t) {
      var list = sameSigList(root, loc.t, loc.x);
      if (list.length) return list[Math.min(loc.o >= 0 ? loc.o : 0, list.length - 1)];
    }
    if (loc.p) return byPath(root, loc.p);
    return null;
  }

  // ---- storage ------------------------------------------------------------

  function loadSeq(rootId) {
    try {
      var raw = localStorage.getItem(keyFor(rootId));
      if (!raw) return null;
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : (data && data.seq) || null;
    } catch (e) { return null; }
  }

  function persist(rootId) {
    var seq = sequences.get(rootId) || [];
    try {
      if (seq.length) localStorage.setItem(keyFor(rootId), JSON.stringify(seq));
      else localStorage.removeItem(keyFor(rootId));
    } catch (e) { console.warn('[activity] save failed for', rootId, e); }
  }

  function scheduleSave(rootId) {
    clearTimeout(saveTimers.get(rootId));
    saveTimers.set(rootId, setTimeout(function () {
      persist(rootId);
      saveTimers.delete(rootId);
    }, SAVE_DELAY));
  }

  // ---- recording ----------------------------------------------------------

  // Capture phase: compute the locator BEFORE the activity's own handler runs and
  // (often) re-renders the clicked node out of the DOM.
  function onClickCapture(e) {
    if (replaying || !e.isTrusted) return;                       // ignore our synthetic replays
    if (window.dataManager && window.dataManager.suppressAutoSave) return; // reset in progress
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    try {
      if (t.closest('a[href]')) return;                          // never record navigation
      if (t.closest('input, select, textarea, label')) return;   // native controls -> data-manager.js
      if (t.closest(UI_EXCLUDE)) return;                         // toolbar / nav / sidebar
      if (t.closest(FRAMEWORK_EXCLUDE)) return;                  // owned by another script / not persisted
      var article = articleOf(t);
      if (!article) return;
      var root = activityRoot(t, article);
      if (!root || !root.id || EXCLUDE_IDS.indexOf(root.id) >= 0) return;
      if (root.querySelector('canvas')) return;                  // live simulation -> skip
      var ctrl = controlOf(t, root);
      if (!ctrl) return;                                         // non-interactive click

      var seq = sequences.get(root.id);
      if (!seq) { seq = loadSeq(root.id) || []; sequences.set(root.id, seq); }
      if (seq.length >= MAX_EVENTS) return;
      seq.push(locatorOf(ctrl, root));
      scheduleSave(root.id);
    } catch (err) { /* never let recording break a real click */ }
  }

  // ---- replay -------------------------------------------------------------

  function replayAll() {
    var base = PREFIX + window.location.pathname + '__activity__';
    var rootIds = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(base) === 0) rootIds.push(k.slice(base.length));
    }
    rootIds.forEach(function (rootId) {
      var root = document.getElementById(rootId);
      if (!root) return;                       // widget not on this build anymore
      var seq = loadSeq(rootId);
      if (!seq || !seq.length) return;
      sequences.set(rootId, seq.slice());      // so later real clicks append to it
      replaying = true;
      try {
        seq.forEach(function (loc) {
          var el = resolve(loc, root);
          if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
      } catch (err) {
        console.warn('[activity] replay failed for', rootId, err);
      } finally {
        replaying = false;
      }
    });
  }

  // ---- init ---------------------------------------------------------------

  function init() {
    document.addEventListener('click', onClickCapture, true);
    // Flush any pending debounced save if the page is hidden/closed mid-edit.
    window.addEventListener('pagehide', function () {
      saveTimers.forEach(function (id, rootId) { clearTimeout(id); persist(rootId); });
      saveTimers.clear();
    });
    replayAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Small debug/manual surface (parity with the other persistence modules).
  window.activityPersistence = {
    replayAll: replayAll,
    sequences: sequences,
    excludeIds: EXCLUDE_IDS
  };
})();
