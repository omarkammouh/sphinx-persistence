/**
 * Simple Book Progress Exporter/Importer
 * Exports and imports all saved data as downloadable/uploadable JSON files
 */

class BookProgressManager {
    constructor() {
        this.init();
    }

    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.addButtons());
        } else {
            this.addButtons();
        }
    }

    addButtons() {
        // Idempotency: if our buttons already exist (e.g. the script was loaded
        // twice), don't add a second set.
        if (document.getElementById('progress-buttons')) {
            return;
        }

        // Build the three actions as monochrome, theme-native icon buttons. They
        // dock into the article header's button bar (next to Live Code / GitHub /
        // download), so they inherit the theme's button styling and never cover
        // page content. The icons inherit the theme text colour, no bright fills.
        const group = document.createElement('div');
        group.id = 'progress-buttons';
        group.className = 'progress-buttons';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        fileInput.id = 'import-file-input';
        fileInput.addEventListener('change', (e) => this.importProgress(e));

        const exportButton = this.makeIconButton(
            'export-progress-btn', 'fa-file-export', 'Export your progress to a file',
            () => this.exportProgress());
        const importButton = this.makeIconButton(
            'import-progress-btn', 'fa-file-import', 'Import progress from a file',
            () => fileInput.click());
        const resetButton = this.makeIconButton(
            'data-reset-btn', 'fa-arrows-rotate', 'Reset your saved progress',
            () => this.showResetDialog());

        group.appendChild(exportButton);
        group.appendChild(importButton);
        group.appendChild(resetButton);
        group.appendChild(fileInput);

        this.injectStyles();
        this.dockButtons(group);
        this.initTooltips(group);
    }

    /** A theme-styled icon-only button (monochrome, inherits header button look). */
    makeIconButton(id, iconClass, label, onClick) {
        const button = document.createElement('button');
        button.id = id;
        button.type = 'button';
        button.className = 'btn btn-sm progress-buttons__btn';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.setAttribute('data-bs-toggle', 'tooltip');
        button.setAttribute('data-bs-placement', 'bottom');
        button.innerHTML = `<span class="btn__icon-container"><i class="fa-solid ${iconClass}"></i></span>`;
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * Place the button group in the optimal spot: the article header's button
     * bar (alongside Live Code / source / download). Falls back to an unobtrusive
     * fixed corner only if that bar isn't present on the page.
     */
    dockButtons(group) {
        const headerBar = document.querySelector('.article-header-buttons');
        if (headerBar) {
            headerBar.appendChild(group);
            return;
        }
        // Fallback: a low-profile fixed cluster in the bottom-right corner.
        group.classList.add('progress-buttons--floating');
        const place = () => document.body.appendChild(group);
        if (document.body) place();
        else window.addEventListener('DOMContentLoaded', place);
    }

    /** Best-effort Bootstrap tooltips (the theme ships Bootstrap); title is the fallback. */
    initTooltips(group) {
        const wire = () => {
            if (!window.bootstrap || !window.bootstrap.Tooltip) return false;
            group.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
                try { new window.bootstrap.Tooltip(el); } catch (e) { /* native title fallback */ }
            });
            return true;
        };
        // Bootstrap may load after us; if it isn't ready yet, retry once on load.
        if (!wire()) window.addEventListener('load', wire, { once: true });
    }

    /** Inject the small, scoped stylesheet for the button group (once). */
    injectStyles() {
        if (document.getElementById('progress-buttons-styles')) return;
        const style = document.createElement('style');
        style.id = 'progress-buttons-styles';
        style.textContent = `
            .progress-buttons { display: inline-flex; align-items: center; gap: 0.15rem; }
            .progress-buttons__btn { color: inherit; background: transparent; border: none;
                box-shadow: none; padding: 0.25rem 0.4rem; line-height: 1; opacity: 0.85; }
            .progress-buttons__btn:hover, .progress-buttons__btn:focus {
                opacity: 1; background: var(--pst-color-surface, rgba(128,128,128,0.15)); }
            .progress-buttons--floating { position: fixed; bottom: 16px; right: 16px;
                z-index: 1030; gap: 0.25rem; padding: 0.25rem 0.4rem; border-radius: 8px;
                background: var(--pst-color-surface, #fff);
                box-shadow: 0 1px 6px rgba(0,0,0,0.18); }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * A best-effort identifier for this book, used only to warn when a progress
     * file came from a different book. Prefers the `persistence_book_id` Sphinx
     * option, then an explicit <meta name="book-id"> (authors can add one via
     * html_meta), else falls back to the host.
     */
    getBookId() {
        const cfg = window.sphinxPersistence || {};
        if (cfg.bookId) return cfg.bookId;
        const meta = document.querySelector('meta[name="book-id"]');
        return (meta && meta.content) || window.location.host || 'unknown-book';
    }

    exportProgress() {
        try {
            // Collect all saved form data (abm_book_*).
            const allData = {};
            const storagePrefix = 'abm_book_';

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith(storagePrefix)) {
                    const value = localStorage.getItem(key);
                    try {
                        allData[key] = JSON.parse(value);
                    } catch {
                        allData[key] = value;
                    }
                }
            }

            // Also include saved live-code cells (thebe_code_*), as raw strings,
            // under their canonical keys.
            if (window.thebeCodePersistence) {
                Object.assign(allData, window.thebeCodePersistence.exportCodeKeys());
            }

            // Create export object. The schema/version/bookId let import detect a
            // file from an older book build or a different book and warn instead of
            // silently writing keys that no longer line up.
            const exportData = {
                schema: 'abm-book-progress',
                schemaVersion: 2,
                bookId: this.getBookId(),
                bookTitle: document.title || 'ABM Book Progress',
                exportDate: new Date().toISOString(),
                totalItems: Object.keys(allData).length,
                data: allData
            };

            // Download as JSON file
            this.downloadJSON(exportData);
            this.showNotification('Progress exported successfully! (including code cells)');

        } catch (error) {
            console.error('Export failed:', error);
            this.showNotification('Export failed. Please try again.', 'error');
        }
    }

    importProgress(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importData = JSON.parse(e.target.result);

                // Structure validation: `data` must be a plain object of keys.
                if (!importData.data || typeof importData.data !== 'object') {
                    throw new Error('Invalid file format');
                }
                // Version check: accept legacy (no schemaVersion) as v1; warn but
                // proceed best-effort if the file is newer than we understand.
                if (importData.schemaVersion && importData.schemaVersion > 2) {
                    this.showNotification('This file is from a newer version; importing best-effort.', 'error');
                }
                // Book check: a file from a different book may not line up.
                if (importData.bookId && importData.bookId !== this.getBookId()) {
                    this.showNotification('Heads up: this file was exported from a different book.', 'error');
                }

                let importCount = 0;
                let codeCellCount = 0;
                let skippedCount = 0;

                // Import all data to localStorage. Form data (abm_book_*) and
                // live-code cells (thebe_code_*) are both stored as-is; the
                // post-import reload triggers code restore via inject-before-activation.
                // Legacy `currentCodeCells` blocks from old exports are ignored.
                Object.entries(importData.data).forEach(([key, value]) => {
                    if (key === 'currentCodeCells') {
                        return; // legacy format, no longer supported, skip safely
                    }
                    if (key.startsWith('thebe_code_')) {
                        // If the entry targets a cell on THIS page whose source has
                        // changed since export, skip it rather than restore stale
                        // code into the wrong cell. Other pages are validated lazily
                        // by the per-page restore guard on next visit.
                        if (window.thebeCodePersistence &&
                            window.thebeCodePersistence.checkEntry(key, value) === 'mismatch') {
                            skippedCount++;
                            return;
                        }
                        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
                        codeCellCount++;
                    } else if (key.startsWith('abm_book_')) {
                        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
                        importCount++;
                    }
                });

                let message = `Progress imported! ${importCount} items restored.`;
                if (codeCellCount > 0) {
                    message += ` ${codeCellCount} code cells restored.`;
                }
                if (skippedCount > 0) {
                    message += ` ${skippedCount} skipped (book changed).`;
                }

                this.showNotification(message);

                // Refresh page to show imported data
                setTimeout(() => window.location.reload(), 1500);
                
            } catch (error) {
                console.error('Import failed:', error);
                this.showNotification('Import failed. Please check the file format.', 'error');
            }
        };
        
        reader.readAsText(file);
        // Clear the input so the same file can be selected again
        event.target.value = '';
    }

    downloadJSON(data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `abm-book-progress-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: ${type === 'error' ? 'var(--abm-danger,#B3261E)' : 'var(--abm-success,#006B54)'};
            color: white;
            padding: 10px 15px;
            border-radius: 4px;
            z-index: 10000;
            font-size: 14px;
            font-weight: 500;
            max-width: 300px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            text-align: center;
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }

    showResetDialog() {
        // Remove existing dialog if any
        const existingDialog = document.querySelector('.reset-dialog');
        if (existingDialog) existingDialog.remove();

        const dialog = document.createElement('div');
        dialog.className = 'reset-dialog';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            border: 2px solid var(--abm-border,#B3E0F2);
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            z-index: 10001;
            padding: 20px;
            min-width: 300px;
            text-align: center;
        `;

        dialog.innerHTML = `
            <h3 style="margin-top: 0; color: var(--abm-ink,#0C2340);">Reset Options</h3>
            <p style="color: #666; margin: 15px 0;">What would you like to reset?</p>
            <p style="color: #888; font-size: 13px; margin: 10px 0; padding: 8px; background: #f8f9fa; border-radius: 4px;">
                ⚠️ This clears your saved progress: form inputs, answers, and live-code cells. This cannot be undone.
            </p>
            <div style="margin: 20px 0;">
                <button onclick="if(window.dataManager) { window.dataManager.resetCurrentPage(); } this.closest('.reset-dialog').remove(); document.querySelector('.reset-backdrop')?.remove();" 
                        style="background: var(--abm-hint,#A63D18); color: #fff; border: none; padding: 10px 20px; margin: 5px; border-radius: 5px; cursor: pointer; font-weight: 500;">
                    🔄 Current Page Only
                </button>
            </div>
            <div style="margin: 20px 0;">
                <button onclick="if(window.dataManager) { window.dataManager.resetEntireBook(); } this.closest('.reset-dialog').remove(); document.querySelector('.reset-backdrop')?.remove();" 
                        style="background: var(--abm-danger,#B3261E); color: white; border: none; padding: 10px 20px; margin: 5px; border-radius: 5px; cursor: pointer; font-weight: 500;">
                    🗑️ Entire Book
                </button>
            </div>
            <div style="margin: 20px 0 0 0;">
                <button onclick="this.closest('.reset-dialog').remove(); document.querySelector('.reset-backdrop')?.remove();" 
                        style="background: var(--abm-muted,#5C5C5C); color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer;">
                    Cancel
                </button>
            </div>
        `;

        document.body.appendChild(dialog);

        // Add backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'reset-backdrop';
        backdrop.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 10000;
        `;
        backdrop.onclick = () => {
            dialog.remove();
            backdrop.remove();
        };
        document.body.appendChild(backdrop);
    }

    resetCurrentPage() {
        if (window.dataManager) {
            window.dataManager.resetCurrentPage();
            this.showNotification('Current page reset successfully!');
        } else {
            this.showNotification('Reset failed: Data manager not available', 'error');
        }
    }

    resetEntireBook() {
        if (window.dataManager) {
            window.dataManager.resetEntireBook();
            this.showNotification('Entire book reset successfully!');
        } else {
            this.showNotification('Reset failed: Data manager not available', 'error');
        }
    }
}

// Initialize progress manager and make it globally accessible
window.bookProgressManager = new BookProgressManager();
