/**
 * TeachBooks-Questions persistence adapter.
 *
 * The TeachBooks-Questions extension (multiple-choice + short-answer) keeps a
 * reader's answer purely in the DOM and stores NOTHING in localStorage, so every
 * answer is lost on reload. data-manager.js can't help here because the answers
 * are not standard form controls:
 *
 *   - Multiple-choice (single- and multiple-select): a chosen option is a
 *     `selected` CSS class on that option's `div.sd-card-body` (inside
 *     `div.sd-card.option`), there is no <input>, value, or name. We record
 *     which option indices are selected and re-apply the class on load.
 *   - Short-answer MATH fields: rendered as MathLive `<math-field>` custom
 *     elements (not <input>), so we save/restore their `.value` (LaTeX).
 *   - Short-answer TEXT fields ARE real <input> elements, so data-manager.js
 *     already persists them, this adapter deliberately ignores those.
 *
 * Keys use the `abm_book_` prefix so the existing Reset / Export / Import flow
 * (book-exporter.js + data-manager.js) covers question answers automatically.
 * One key per question: abm_book_<path>__question__<questionId>.
 */
(function () {
  const PREFIX = 'abm_book_';
  const SAVE_DELAY = 300;
  const QUESTION_SELECTOR = 'div.multiple-choice[id], div.short-answer[id]';

  function keyFor(questionId) {
    return `${PREFIX}${window.location.pathname}__question__${questionId}`;
  }

  /** The option cards (in DOM order) for a question, index = stable identity. */
  function optionCards(questionDiv) {
    const section = document.getElementById(`${questionDiv.id}-options`);
    if (!section) return [];
    return Array.from(section.querySelectorAll('div.sd-card.option'));
  }

  function mathFields(questionDiv) {
    return Array.from(questionDiv.querySelectorAll('math-field[id]'));
  }

  /** Snapshot the current answer: selected option indices + math-field values. */
  function readState(questionDiv) {
    const selected = [];
    optionCards(questionDiv).forEach((card, i) => {
      const body = card.querySelector('div.sd-card-body');
      if (body && body.classList.contains('selected')) selected.push(i);
    });
    const math = {};
    mathFields(questionDiv).forEach(mf => {
      const v = mf.value != null ? mf.value : '';
      if (v) math[mf.id] = v;
    });
    return { selected, math };
  }

  function hasState(state) {
    return (state.selected && state.selected.length > 0) ||
      (state.math && Object.keys(state.math).length > 0);
  }

  function save(questionDiv) {
    try {
      const state = readState(questionDiv);
      const key = keyFor(questionDiv.id);
      if (hasState(state)) {
        localStorage.setItem(key, JSON.stringify(state));
      } else {
        localStorage.removeItem(key); // answer cleared (e.g. the question's Reset)
      }
    } catch (e) {
      console.warn('[tb-questions] save failed:', e);
    }
  }

  function restore(questionDiv) {
    let state;
    try {
      const raw = localStorage.getItem(keyFor(questionDiv.id));
      if (!raw) return;
      state = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const cards = optionCards(questionDiv);
    (state.selected || []).forEach(i => {
      const card = cards[i];
      const body = card && card.querySelector('div.sd-card-body');
      if (body) body.classList.add('selected');
    });

    if (state.math) {
      const applyMath = () => mathFields(questionDiv).forEach(mf => {
        if (state.math[mf.id] != null) {
          try { mf.value = state.math[mf.id]; } catch (e) { /* not upgraded yet */ }
        }
      });
      applyMath();
      // MathLive may upgrade <math-field> only after its CDN script loads, retry.
      if (window.customElements && !customElements.get('math-field')) {
        customElements.whenDefined('math-field').then(applyMath).catch(() => {});
      }
    }
  }

  const saveTimers = new Map();
  function debouncedSave(questionDiv) {
    clearTimeout(saveTimers.get(questionDiv.id));
    saveTimers.set(questionDiv.id, setTimeout(() => save(questionDiv), SAVE_DELAY));
  }

  function init() {
    document.querySelectorAll(QUESTION_SELECTOR).forEach(restore);

    // Save AFTER the extension's own click handler has toggled the selection.
    // setTimeout(0) defers past the synchronous click handlers regardless of
    // script load order, so we read the post-toggle state. Covers option clicks
    // and the question's own Reset (which clears the answer → key removed).
    document.addEventListener('click', function (event) {
      const q = event.target.closest && event.target.closest('div.multiple-choice, div.short-answer');
      if (q && q.id) setTimeout(() => save(q), 0);
    });

    // Save math-field edits (MathLive fires input/change; text <input>s are left
    // to data-manager.js, so we only react to math-field targets here).
    const onMathEdit = function (event) {
      const mf = event.target.closest && event.target.closest('math-field');
      if (!mf) return;
      const q = mf.closest('div.short-answer');
      if (q && q.id) debouncedSave(q);
    };
    document.addEventListener('input', onMathEdit);
    document.addEventListener('change', onMathEdit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
