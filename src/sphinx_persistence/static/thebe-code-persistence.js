/**
 * Thebe Code Persistence Manager (CodeMirror 5 / thebe-lite)
 *
 * thebe-lite (the TeachBooks fork) renders live code cells with CodeMirror 5
 * (DOM: `div.CodeMirror.cm-s-default` whose element carries the editor instance
 * on `el.CodeMirror`, with `.getValue()` / `.setValue()` / `.on('change')`).
 * It is NOT CodeMirror 6 (`.cm-editor`/`.cm-content`/`.cm-line`). This was
 * verified live in a real browser: an activated cell contains
 * `div.CodeMirror.cm-s-default` and `thebe.notebook.cells[i].source` holds the
 * full text. Earlier CM6-based attempts (input listeners, `.cm-line` reads,
 * MutationObserver on `.cm-content`) never fired because those elements do not
 * exist here.
 *
 * Two responsibilities, both using the CM5 instance directly:
 *
 *  - RESTORE (inject-before-activation): before the user clicks "Live Code", a
 *    code cell is a static `<pre>`. thebe seeds the editor from that `<pre>`'s
 *    text on activation (its input selector is `pre`), so on load we overwrite
 *    the `<pre>` with the saved code. If a cell is already live, we instead
 *    `setValue()` on its CM5 instance.
 *
 *  - SAVE: when a CM5 editor mounts we attach a native `change` handler that
 *    debounce-saves `cm.getValue()`. A `flushAll()` on pagehide/visibilitychange
 *    snapshots every live editor synchronously right before unload, so the most
 *    recent keystrokes are never lost to a pending debounce.
 *
 * Cell identity is positional: the index among `.thebe, .cell` containers in
 * document order, the exact selector/order thebe uses to assign `codecell{N}`
 * ids at activation, so the restore index and the save index always agree.
 * Canonical key: `thebe_code_${location.pathname}__${index}`. Each saved value
 * is a small JSON envelope `{v:2, code, origin}`, where `origin` is a hash of the
 * cell's *pristine* source captured at load. On restore we only inject the saved
 * code when `origin` still matches the current pristine source, so if the author
 * later inserts/reorders/edits cells (a book update), a stale entry is skipped
 * rather than injected into the wrong cell. Legacy raw-string values (no envelope)
 * restore as-is with origin unknown, and upgrade to an envelope on the next save.
 *
 * OUT OF SCOPE: kernel-side interactive state, ipywidgets sliders/buttons, Mesa
 * model objects, matplotlib figures, is NOT persisted. It lives in the Pyodide
 * kernel, not the DOM/localStorage, and is gone on reload. The cell *source* that
 * creates those widgets IS saved, so re-running the cell restores them; that is
 * the intended workflow.
 */

const CODE_CELL_SELECTOR = '.thebe, .cell';
const SKIP_TAGS = ['tag_read-only', 'tag_thebe-remove-input-init'];

class ThebeCodePersistence {
    constructor() {
        this.storagePrefix = 'thebe_code_';
        this.saveDelay = 400;
        this.saveTimeouts = new Map();
        // While true, ALL saves no-op (debounced saves AND the unload flush). Set
        // by prepareForResetReload() just before a reset reloads the page, so the
        // cleared keys can't be resurrected by an in-flight debounce or the
        // pagehide flush. Resets to false on the fresh page after reload.
        this.suppressSave = false;
        // CM5 instances we've already wired a change handler to.
        this.attachedEditors = new WeakSet();
        // Number of static code cells present at load. Cells beyond this index
        // are created at runtime by thebe's "add cell" button and are ephemeral,
        // so we never persist them.
        this.staticCellCount = 0;
        // Hash of each cell's pristine source at load, keyed by index. Used to
        // detect when a book edit has shifted/changed a cell so a stale saved
        // entry isn't restored into the wrong cell.
        this.originHashes = new Map();
        // Kill thebe's misleading "unsaved changes" unload prompt up front
        // (synchronously, before init defers to DOMContentLoaded).
        this.disableUnloadPrompt();
        this.init();
    }

    /**
     * thebe's refresh.js does `window.onbeforeunload = () => 1` while live code is
     * active, so the browser shows a "Leave site? Changes may not be saved" prompt
     * on refresh/navigation. That warning is wrong here, our autosave + unload
     * flush already persist the code, so we permanently neutralize the
     * onbeforeunload PROPERTY (what refresh.js sets). Our own save-on-exit handlers
     * are registered via addEventListener, so they are unaffected and the code is
     * still flushed before unload. Whether our script runs before or after
     * refresh.js, the accessor wins: an earlier assignment is overridden, a later
     * one is ignored by the no-op setter.
     */
    disableUnloadPrompt() {
        try {
            Object.defineProperty(window, 'onbeforeunload', {
                configurable: true,
                get() { return null; },
                set() { /* ignore: persistence makes the warning unnecessary */ },
            });
        } catch (e) {
            window.onbeforeunload = null; // fallback if the property can't be redefined
        }
    }

    // ---- Content fingerprint (book-edit-tolerant identity) -----------------

    /** Normalize source for a stable hash (line endings + trailing whitespace). */
    normalizeSource(text) {
        return (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
    }

    /** Small, synchronous FNV-1a 32-bit hash → hex string. */
    hashSource(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }

    /** Record the pristine <pre> hash for every code cell, before restore runs. */
    captureOriginHashes() {
        this.originHashes = new Map();
        this.getCodeCells().forEach((container, index) => {
            if (this.shouldSkip(container)) return;
            const pre = container.querySelector('.cell_input pre') || container.querySelector('pre');
            if (pre) this.originHashes.set(index, this.hashSource(this.normalizeSource(pre.textContent)));
        });
    }

    /**
     * Parse a stored value into `{ code, origin }`. Back-compat: a legacy raw
     * string (no envelope) is treated as code with unknown origin. A malformed
     * value never throws, it falls back to raw.
     */
    readEntry(raw) {
        if (raw === null || raw === undefined) return null;
        try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object' && typeof obj.code === 'string') {
                return { code: obj.code, origin: obj.origin != null ? obj.origin : null };
            }
        } catch (e) { /* not JSON, a legacy raw-string code value */ }
        return { code: raw, origin: null };
    }

    /**
     * Import-validation helper used by book-exporter.js. Returns 'mismatch' when
     * a saved entry targets a cell on THIS page whose pristine source no longer
     * matches (book changed → should be skipped); 'other-page' when it targets a
     * different page (can't check here, the per-page restore guard handles it);
     * 'ok' otherwise (matches, or origin unknown so we keep it).
     */
    checkEntry(key, rawValue) {
        const canonicalPrefix = `${this.storagePrefix}${window.location.pathname}__`;
        if (!key.startsWith(canonicalPrefix)) return 'other-page';
        const m = /__(\d+)$/.exec(key);
        if (!m) return 'ok';
        const index = parseInt(m[1], 10);
        const entry = this.readEntry(typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue));
        const currentOrigin = this.originHashes.get(index);
        if (entry && entry.origin && currentOrigin && entry.origin !== currentOrigin) {
            return 'mismatch';
        }
        return 'ok';
    }

    init() {
        const start = () => {
            this.staticCellCount = this.getCodeCells().length;
            this.captureOriginHashes();   // record pristine source before restore overwrites it
            this.migrateLegacyKeys();
            this.restoreAll();
            this.watchForEditors();
            this.attachFlushHandlers();
            console.log(`[thebe-persist] ready (${this.staticCellCount} code cells, CM5)`);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    }

    /** All code-cell containers in document order (matches thebe's order). */
    getCodeCells() {
        return Array.from(document.querySelectorAll(CODE_CELL_SELECTOR));
    }

    /** Should this cell be skipped for save/restore (read-only / init shim)? */
    shouldSkip(container) {
        return SKIP_TAGS.some(tag => container.classList.contains(tag));
    }

    /** Canonical storage key for a code cell at a given index. */
    keyFor(index) {
        return `${this.storagePrefix}${window.location.pathname}__${index}`;
    }

    /** Derive the positional index, preferring the `codecell{N}` id thebe sets. */
    indexOfContainer(container) {
        const m = /^codecell(\d+)$/.exec(container.id || '');
        if (m) return parseInt(m[1], 10);
        return this.getCodeCells().indexOf(container);
    }

    /** The live CodeMirror 5 instance for a cell, or null if not activated. */
    editorOf(container) {
        const el = container.querySelector('.CodeMirror');
        return el && el.CodeMirror ? el.CodeMirror : null;
    }

    // ---- Restore -----------------------------------------------------------

    restoreAll() {
        this.getCodeCells().forEach((container, index) => {
            if (this.shouldSkip(container)) return;

            const entry = this.readEntry(localStorage.getItem(this.keyFor(index)));
            if (entry === null) return;

            // Book-edit guard: if we have an origin hash for this position and it
            // no longer matches the cell's pristine source, the author changed the
            // cells, this saved code belongs to a different cell now. Skip it
            // (don't inject into the wrong cell; don't delete the user's work).
            const currentOrigin = this.originHashes.get(index);
            if (entry.origin && currentOrigin && entry.origin !== currentOrigin) {
                console.info(`[thebe-persist] skip restore at ${index}: cell source changed since save`);
                return;
            }

            const saved = entry.code;

            // If the cell is already live (rare on a fresh load), push straight
            // into the editor. Otherwise overwrite the static <pre> so thebe
            // seeds the editor from it when the user clicks "Live Code".
            const cm = this.editorOf(container);
            if (cm) {
                if (cm.getValue() !== saved) cm.setValue(saved);
                return;
            }
            const pre = container.querySelector('.cell_input pre') || container.querySelector('pre');
            if (pre) {
                pre.textContent = saved; // strips highlight spans; thebe reads textContent
            }
        });
    }

    // ---- Save --------------------------------------------------------------

    /**
     * Editors mount only when the user activates thebe, and they can be added
     * later too. Scan now and on every DOM mutation, attaching a change handler
     * to each CM5 instance exactly once.
     */
    watchForEditors() {
        this.attachAllEditors();
        this.editorObserver = new MutationObserver(() => this.attachAllEditors());
        this.editorObserver.observe(document.body, { childList: true, subtree: true });
    }

    attachAllEditors() {
        this.getCodeCells().forEach(container => {
            if (this.shouldSkip(container)) return;
            const cm = this.editorOf(container);
            if (!cm || this.attachedEditors.has(cm)) return;

            const index = this.indexOfContainer(container);
            if (index < 0 || index >= this.staticCellCount) return; // ephemeral/unknown

            this.attachedEditors.add(cm);
            cm.on('change', () => this.debouncedSave(index, cm.getValue()));
        });
    }

    debouncedSave(index, code) {
        const existing = this.saveTimeouts.get(index);
        if (existing) clearTimeout(existing);
        const timeoutId = setTimeout(() => {
            this.saveTimeouts.delete(index);
            if (this.suppressSave) return; // a reset is clearing this page
            this.writeKey(index, code);
        }, this.saveDelay);
        this.saveTimeouts.set(index, timeoutId);
    }

    /** Cancel any debounced saves that haven't fired yet. */
    cancelPendingSaves() {
        this.saveTimeouts.forEach(id => clearTimeout(id));
        this.saveTimeouts.clear();
    }

    writeKey(index, code) {
        try {
            // Store an envelope so a later visit can verify this saved code still
            // belongs to the cell at this index (see restoreAll's origin guard).
            const origin = this.originHashes.has(index) ? this.originHashes.get(index) : null;
            localStorage.setItem(this.keyFor(index), JSON.stringify({ v: 2, code, origin }));
        } catch (error) {
            console.warn('[thebe-persist] failed to save code:', error);
        }
    }

    /**
     * Snapshot every live editor right now, synchronously. Runs on page hide so
     * the latest keystrokes survive even if their debounced save hadn't fired.
     */
    flushAll() {
        if (this.suppressSave) return; // a reset is reloading, don't resurrect keys
        this.getCodeCells().forEach(container => {
            if (this.shouldSkip(container)) return;
            const cm = this.editorOf(container);
            if (!cm) return;
            const index = this.indexOfContainer(container);
            if (index < 0 || index >= this.staticCellCount) return;
            this.writeKey(index, cm.getValue());
        });
    }

    attachFlushHandlers() {
        const flush = () => this.flushAll();
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
    }

    // ---- Export / import / clear hooks (used by book-exporter.js) ----------

    /** All thebe_code_* keys across the whole book (export is book-wide). */
    exportCodeKeys() {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.storagePrefix)) {
                out[key] = localStorage.getItem(key);
            }
        }
        return out;
    }

    importCodeKeys(data) {
        let imported = 0;
        Object.entries(data || {}).forEach(([key, value]) => {
            if (key.startsWith(this.storagePrefix)) {
                localStorage.setItem(key, value);
                imported++;
            }
        });
        return imported;
    }

    clearAllCodeKeys() {
        return this.removeKeysWithPrefix(this.storagePrefix);
    }

    clearCurrentPageCodeKeys() {
        return this.removeKeysWithPrefix(`${this.storagePrefix}${window.location.pathname}__`);
    }

    /** Collect-then-remove every localStorage key with the given prefix. */
    removeKeysWithPrefix(prefix) {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) keys.push(key);
        }
        keys.forEach(k => localStorage.removeItem(k));
        return keys.length;
    }

    /**
     * Arm the module for a reset-triggered page reload. The reset flow clears the
     * saved keys then reloads so the page (code cells, outputs, forms) comes back
     * in its pristine state. Without this guard the impending unload would fire
     * flushAll() / a pending debounce and re-save the live editors, resurrecting
     * the very keys the reset just cleared. So we stop in-flight saves and keep
     * saving suppressed; it resumes naturally on the fresh page after reload.
     */
    prepareForResetReload() {
        this.suppressSave = true;
        this.cancelPendingSaves();
        // Recovery net: if the reset's reload never actually happens, re-enable
        // saving so it isn't dead for the rest of the session. No-op normally
        // (the page is gone well before this fires).
        setTimeout(() => { this.suppressSave = false; }, 5000);
    }

    // ---- One-time migration of old key schemes -----------------------------

    /**
     * Older versions wrote `code_cell_*` keys and `thebe_code_..._<selector>_<id>`
     * keys that don't match the canonical `${path}__${index}` shape. Remove the
     * stale ones for this page so they don't linger or inflate reset counts.
     */
    migrateLegacyKeys() {
        const flag = 'abm_book_codekey_migrated_v3';
        if (localStorage.getItem(flag)) return;

        // A canonical key is `thebe_code_<path>__<index>` for ANY page. Test that
        // shape globally so we only drop genuinely malformed thebe keys, never a
        // valid saved cell from another page (the earlier per-page check wrongly
        // matched, and would have wiped other pages' code).
        const canonicalRe = /^thebe_code_.+__\d+$/;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            const isLegacyCodeCell = key.startsWith('code_cell_');
            const isNonCanonicalThebe =
                key.startsWith(this.storagePrefix) && !canonicalRe.test(key);
            if (isLegacyCodeCell || isNonCanonicalThebe) {
                toRemove.push(key);
            }
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        localStorage.setItem(flag, '1');
        if (toRemove.length) {
            console.log(`[thebe-persist] migrated/removed ${toRemove.length} legacy code key(s)`);
        }
    }
}

// Initialize once, even if the script is loaded twice.
if (!window.thebeCodePersistence) {
    window.thebeCodePersistence = new ThebeCodePersistence();
    // Backwards-compatible alias for any external reference.
    window.ThebeCodePersistence = window.thebeCodePersistence;
}
