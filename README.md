# sphinx-persistence

Client-side persistence for interactive Sphinx books (Jupyter Book /
TeachBooks). It saves a reader's work to the browser's `localStorage` (per
origin, per device) and restores it on reload/navigation, with **export /
import / reset** buttons docked into the article header toolbar. Everything is
client-side: no server, no accounts, no third-party services.

It covers the full content spectrum of an interactive book: plain **HTML**
inputs, **MyST**-rendered pages (raw-HTML activities, sphinx-design content,
task lists), **Jupyter notebook live-code cells** (thebe), and
TeachBooks-Questions quizzes.

## Installation

Until the first PyPI release, install straight from GitHub (in a book's
`requirements.txt`, add this as one line):

```
sphinx-persistence @ git+https://github.com/omarkammouh/sphinx-persistence
```

(after the PyPI release this shortens to `pip install sphinx-persistence`)

Then enable it. In a Jupyter Book / TeachBooks `_config.yml`:

```yaml
sphinx:
  extra_extensions:
    - sphinx_persistence
```

In a plain Sphinx `conf.py`:

```python
extensions = ["sphinx_persistence"]
```

That is all: every page now auto-saves reader input and shows the three
toolbar buttons.

## Configuration

All options are optional Sphinx config values (under `sphinx: config:` in
`_config.yml`):

| Option | Default | Meaning |
|---|---|---|
| `persistence_toolbar` | `true` | The export / import / reset buttons. |
| `persistence_code_cells` | `true` | Save live-code (thebe) cell source. |
| `persistence_questions` | `true` | Save TeachBooks-Questions answers (MCQ + math). |
| `persistence_activities` | `true` | Record & replay clicks inside bespoke `{raw} html` activities. |
| `persistence_progress_checkboxes` | `false` | "Mark as done" controls + sidebar completion ticks. Opt-in: expects the `data-learning-activity="true"` / `.la-title` markup convention. |
| `persistence_part_heading_pages` | `""` | JS regex matched against `location.pathname`; on matching pages, `<h2>` part headings with a dotted section number ("3.1.1: ...") also get a completion checkbox. |
| `persistence_activity_exclude_ids` | `[]` | Activity root ids the click recorder must skip (e.g. timed quiz games). |
| `persistence_book_id` | `""` | Identity stamped into progress exports so importing a file from a different book warns. Falls back to `<meta name="book-id">`, then the site host. |

At build time the options are emitted as `_static/sphinx-persistence-config.js`
(a named file rather than an inline script, because the Jupyter Book stack
duplicates inline script bodies in the rendered head), defining
`window.sphinxPersistence` before the modules load.

## Modules

| File | Responsibility | Key prefix |
|------|----------------|------------|
| `data-manager.js` | Form/quiz inputs; shared reset utilities (always loaded) | `abm_book_*` |
| `book-exporter.js` | Export / import / reset toolbar | (all `abm_book_*` + `thebe_code_*`) |
| `thebe-code-persistence.js` | Live-code (thebe-lite / CodeMirror 5) cell source | `thebe_code_*` |
| `teachbook-questions-persistence.js` | TeachBooks-Questions answers (MCQ selection + math fields) | `abm_book_*` |
| `activity-persistence.js` | Bespoke `{raw} html` activities, via click record & replay | `abm_book_*` |
| `progress-checkboxes.js` | "Mark as done" checkboxes below Learning Activities, plus page-completion controls | `abm_book_*` |

## What is persisted

- **Text-like inputs**: `text`, `number`, `email`, `password`, `search`, `url`,
  `tel`, `date`, `time`, `datetime-local`, `color`, `range` (slider), `textarea`.
- **Checkboxes**, each persisted independently.
- **Radio groups**, keyed by the group `name`; exactly one selection is stored
  and restored (no stale multi-selection).
- **Single and multiple `<select>`**, multi-selects store all chosen options.
- **Live-code cell source**, the code a reader types into a `{code-cell}`.
  Each entry carries a fingerprint of the cell's original source, so if the book
  is later edited the saved code is only restored into a cell that still matches
  (otherwise it's skipped, not injected into the wrong cell).
- Dynamically-added inputs (a `MutationObserver` wires them up after load).
- **TeachBooks-Questions answers**, multiple-choice selection (single/multiple)
  and short-answer math (`<math-field>`) values. These aren't standard form
  controls (selection is a CSS class on option cards; math is a MathLive custom
  element), so a dedicated adapter (`teachbook-questions-persistence.js`) saves
  the chosen options / typed math and restores them on load. Short-answer *text*
  inputs are real `<input>`s, handled by `data-manager.js`. Note: the transient
  *feedback* (correct/incorrect, "show answer") is not restored, only the answer.
- **Bespoke `{raw} html` Learning Activities**, the classify / match /
  order / fill-the-gap quizzes and selection widgets whose answer lives in
  private JavaScript closure variables (unreachable from outside). Rather than
  edit every widget, `activity-persistence.js` is a **pluggable, zero-touch**
  engine: it **records the reader's clicks** inside an activity and, on reload,
  **replays them through the activity's own handlers**, which rebuilds the private
  state, the DOM, *and* the graded result (the trailing "Check" click is
  replayed too). It works with no per-activity code. Auto-discovery keys each
  activity by its outermost `div[id]`; it ignores native controls (owned by
  `data-manager.js`), navigation links, the toolbar, and any activity containing a
  `<canvas>` (live simulations). To skip a specific widget, add its root id to
  the `persistence_activity_exclude_ids` option.
  Completion controls use the separate explicit contract:
  `progress-checkboxes.js` finds each `data-learning-activity="true"` root and
  places one **Mark as done** control beneath its `.la-title` card.

## What is NOT persisted (by design / not feasible)

- **ipywidgets / kernel-side interactive widgets** (sliders, buttons,
  `interact`) and **matplotlib/plot interactivity**, these are *kernel-side*
  state, not DOM, and are gone on reload. The cell **source** that creates them
  is saved, so **re-running the cell restores the widget**, that is the
  intended workflow.
- **Code-cell output**, only the source is saved; re-run to regenerate output.
- **Content inside iframes** (YouTube, H5P embeds, externally-hosted widgets).
  For cross-origin frames (e.g. `*.h5p.com`) the browser's same-origin policy
  forbids reading/writing across the boundary, so persisting them is
  impossible from the book side; H5P is out of scope for this package either
  way.
- **Live canvas simulations / games**, their run-state is ephemeral and
  regenerated by re-running, so widgets containing a `<canvas>` are
  intentionally skipped by `activity-persistence.js`. Any `<input type=range>` /
  checkbox controls they expose still persist via `data-manager.js`.
- **Video playback position**, accordion/toggle open-state (including
  sphinx-design tab-sets, whose hidden radio inputs are deliberately treated as
  UI chrome, not reader work).

## Robustness notes

- Saves are **debounced** and **flushed on page hide/unload**, so the latest
  keystrokes survive navigation.
- **Scope**: per browser + per device. Not synced across devices; cleared if the
  user clears browser data. Use **Export** to move progress between devices.
- **Quota** (~5 MB/origin): a one-time warning is shown if the store is full.
- **Multiple tabs** on the same page: last tab to close wins (known limitation).
- **Reset** clears saved keys then reloads so the page returns to its pristine
  state. GitHub auth tokens are never touched.

## Export / import format

`Export` downloads a JSON file:

```json
{
  "schema": "abm-book-progress",
  "schemaVersion": 2,
  "bookId": "<persistence_book_id, <meta name=\"book-id\">, or host>",
  "bookTitle": "...",
  "exportDate": "2026-...",
  "totalItems": 12,
  "data": { "abm_book_...": "...", "thebe_code_...__0": "{\"v\":2,\"code\":\"...\",\"origin\":\"...\"}" }
}
```

On **import**, the file is validated: a different `bookId` or a newer
`schemaVersion` shows a non-blocking warning, and live-code entries whose
fingerprint no longer matches the current page's cells are skipped (reported as
"N skipped (book changed)") rather than restored into the wrong cell. Legacy
exports without a schema still import.

## Compatibility note on storage keys

The localStorage key prefixes (`abm_book_*`, `thebe_code_*`) are part of the
on-disk contract with readers' browsers: changing them would orphan everyone's
saved progress. They are therefore fixed, and deliberately not configurable.

## Development

The JS lives in `src/sphinx_persistence/static/`. Sphinx serves the installed
copy, so after editing, reinstall from your checkout before rebuilding the
site you test against:

```
pip install --force-reinstall --no-deps /path/to/sphinx-persistence
```

then rebuild (a clean rebuild if only static assets changed).
