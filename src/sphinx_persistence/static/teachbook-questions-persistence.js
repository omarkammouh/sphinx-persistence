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
 *   - Short-answer TEXT fields and inline gaps are real form controls, so
 *     data-manager.js persists the typed values; this adapter adds grading and
 *     show-answer state for them.
 *
 * Keys use the `abm_book_` prefix so the existing Reset / Export / Import flow
 * (book-exporter.js + data-manager.js) covers question answers automatically.
 * It also saves grading: option footer feedback classes, the overall feedback
 * card shown after Submit, and show-answer mode. In show-answer mode the field
 * holds the correct answer, so the student's own math value is kept separately.
 *
 * One key per question: abm_book_<path>__question__<questionId>.
 */
(function () {
  const PREFIX = 'abm_book_';
  const SAVE_DELAY = 300;
  const QUESTION_SELECTOR = 'div.multiple-choice[id], div.short-answer[id]';
  const FEEDBACK_CLASSES = ['correct', 'incorrect', 'show-answer', 'show-feedback', 'parsing-error'];

  function keyFor(questionId) {
    return `${PREFIX}${window.location.pathname}__question__${questionId}`;
  }

  /** The option cards (in DOM order) for a question, index = stable identity. */
  function optionCards(questionDiv) {
    const section = document.getElementById(`${questionDiv.id}-options`);
    if (!section) return [];
    return Array.from(section.querySelectorAll('div.sd-card.option'));
  }

  /** Inline-gap cards (span.inline-card.field) for questions without option cards. */
  function answerCards(questionDiv) {
    const options = optionCards(questionDiv);
    return options.length ? options : Array.from(questionDiv.querySelectorAll('span.inline-card.field'));
  }

  /** Fillable fields keyed by element id (blocks) or gap index (inline gaps). */
  function answerFields(questionDiv) {
    const fields = [];
    questionDiv.querySelectorAll('textarea.question-option-input[id], math-field[id]').forEach(el => {
      if (!el.closest('span.inline-card')) fields.push({ key: el.id, el });
    });
    questionDiv.querySelectorAll('span.inline-card.field').forEach((card, i) => {
      const el = card.querySelector('input.question-option-input, math-field.question-option-input, select.question-option-input');
      if (el) fields.push({ key: `gap-${i}`, el });
    });
    return fields;
  }

  function valueOf(el) {
    return el.tagName === 'SELECT' ? String(el.selectedIndex) : (el.value || '');
  }

  function setValue(el, v) {
    if (el.tagName === 'SELECT') el.selectedIndex = Number(v);
    else el.value = v;
  }

  function overallCards(questionDiv) {
    const section = document.getElementById(`${questionDiv.id}-overall-feedback`);
    if (section) return Array.from(section.querySelectorAll('div.sd-card'));
    return Array.from(questionDiv.querySelectorAll('section.question-feedback div.sd-card'));
  }

  // Show answer writes the correct answer into the field, so the student's own
  // math-field value is kept here while that mode is active.
  const studentMath = new Map();

  /** Snapshot the current answer and grading: selections, feedback, and show-answer mode. */
  function readState(questionDiv) {
    const selected = [];
    const feedback = {};
    answerCards(questionDiv).forEach((card, i) => {
      const body = card.querySelector('div.sd-card-body');
      if (body && body.classList.contains('selected')) selected.push(i);
      const footer = card.querySelector('div.sd-card-footer, span.inline-card-footer');
      const classes = footer ? FEEDBACK_CLASSES.filter(c => footer.classList.contains(c)) : [];
      if (classes.length) feedback[i] = classes;
    });
    const overall = [];
    overallCards(questionDiv).forEach((card, i) => {
      if (card.classList.contains('show')) overall.push(i);
    });

    const math = {};
    const shown = {};
    answerFields(questionDiv).forEach(({ key, el }) => {
      const isShown = el.classList.contains('show-answer');
      if (el.tagName === 'MATH-FIELD') {
        if (isShown) {
          shown[key] = el.value || '';
          if (studentMath.get(key)) math[key] = studentMath.get(key);
        } else {
          const v = el.value || '';
          studentMath.set(key, v);
          if (v) math[key] = v;
        }
      } else if (isShown) {
        shown[key] = valueOf(el);
      }
    });

    return { selected, feedback, overall, math, shown };
  }

  function hasState(state) {
    return state.selected.length > 0 || Object.keys(state.feedback).length > 0 ||
      state.overall.length > 0 || Object.keys(state.math).length > 0 ||
      Object.keys(state.shown).length > 0;
  }

  function setReadOnly(field, readOnly) {
    field.readOnly = readOnly;
    if (field.tagName === 'MATH-FIELD') {
      if (readOnly) field.setAttribute('read-only', '');
      else field.removeAttribute('read-only');
    }
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

    const cards = answerCards(questionDiv);
    (state.selected || []).forEach(i => {
      const card = cards[i];
      const body = card && card.querySelector('div.sd-card-body');
      if (body) body.classList.add('selected');
    });

    Object.entries(state.feedback || {}).forEach(([i, classes]) => {
      const footer = cards[i] && cards[i].querySelector('div.sd-card-footer, span.inline-card-footer');
      if (footer) footer.classList.add(...classes);
    });
    const overall = overallCards(questionDiv);
    (state.overall || []).forEach(i => {
      if (overall[i]) overall[i].classList.add('show');
    });

    Object.entries(state.math || {}).forEach(([id, v]) => studentMath.set(id, v));

    const applyValues = () => {
      answerFields(questionDiv).forEach(({ key, el }) => {
        try {
          if (el.tagName === 'MATH-FIELD' && state.math && state.math[key] != null) el.value = state.math[key];
          if (state.shown && state.shown[key] != null) {
            setValue(el, state.shown[key]);
            el.classList.add('show-answer');
            setReadOnly(el, true);
          }
        } catch (e) { /* math-field not upgraded yet */ }
      });
    };
    applyValues();
    // Text inputs are restored by data-manager.js, which may run after this, so apply again on the next tick.
    setTimeout(applyValues, 0);
    // MathLive may upgrade <math-field> only after its CDN script loads, retry.
    if (window.customElements && !customElements.get('math-field')) {
      customElements.whenDefined('math-field').then(applyValues).catch(() => {});
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
      if (!q || !q.id) return;
      const isTryAgain = !!event.target.closest('div.sd-card.reset-button');
      setTimeout(() => {
        // Try again clears fields without firing input/change, so data-manager.js
        // would keep the old values. Dispatch them so it saves the cleared state.
        if (isTryAgain) {
          q.querySelectorAll('.question-option-input').forEach(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
        save(q);
      }, 0);
    });

    // Focusing a short-answer field clears its feedback and show-answer mode, without a click.
    document.addEventListener('focusin', function (event) {
      const q = event.target.closest && event.target.closest('div.multiple-choice, div.short-answer');
      if (q && q.id) debouncedSave(q);
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
