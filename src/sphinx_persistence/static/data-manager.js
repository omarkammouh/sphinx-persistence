/**
 * Centralized Data Management System
 * Automatically saves all input field data to browser's local storage
 * and restores it on page load for persistence across sessions
 */

class DataManager {
    constructor() {
        this.storagePrefix = 'abm_book_';
        this.saveDelay = 500; // 500ms delay for auto-save
        this.saveTimeouts = new Map();

        // While a reset is in progress, the autosave listeners must not run.
        // clearCurrentPageForms() dispatches synthetic input/change events to
        // refresh dependent UI; without this guard those events re-save the
        // just-cleared (empty) values, so keys reappear and a 2nd reset still
        // "removes" them. Checked at fire time so it also covers debounced saves.
        this.suppressAutoSave = false;

        // Single source of truth for which localStorage keys this book owns.
        // managedPrefixes are the live schemes; legacyPrefixes are old schemes
        // that reset should clean up but nothing re-creates.
        this.codeCellPrefix = 'thebe_code_';          // owned by thebe-code-persistence.js
        this.managedPrefixes = ['abm_book_', 'thebe_code_'];
        this.legacyPrefixes = ['book_', 'code_cell_'];

        this.init();
    }

    init() {
        console.log('DataManager initializing...');
        // Wait for DOM to be fully loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.setupAutoSave();
            });
        } else {
            this.setupAutoSave();
        }
    }

    /**
     * Get a unique key for storage based on page URL and element
     */
    getStorageKey(element) {
        const pageUrl = window.location.pathname;
        // Radio groups are keyed by their shared `name`, not per-element. The
        // store then holds the single *selected value* rather than a per-radio
        // boolean, deselecting a radio fires no event, so the old per-radio
        // scheme left several radios "checked" after a reload.
        if (element.type === 'radio' && element.name) {
            return `${this.storagePrefix}${pageUrl}__radio__${element.name}`;
        }
        const elementId = element.id || element.name || this.generateElementId(element);
        return `${this.storagePrefix}${pageUrl}_${elementId}`;
    }

    /**
     * Generate a unique ID for elements without one
     */
    generateElementId(element) {
        const tagName = element.tagName.toLowerCase();
        const parent = element.parentElement;
        const siblings = Array.from(parent.children).filter(child => 
            child.tagName.toLowerCase() === tagName && 
            child.type === element.type
        );
        const index = siblings.indexOf(element);
        return `${tagName}_${element.type || 'text'}_${index}`;
    }

    /**
     * Save data to local storage
     */
    saveToStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify({
                value: value,
                timestamp: Date.now(),
                url: window.location.pathname
            }));
            console.debug(`Saved to storage: ${key}`, value);
        } catch (error) {
            console.warn('Failed to save to localStorage:', error);
            // Surface a quota error once so the user knows progress may be lost
            // (and can export + reset to recover space).
            if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
                if (!this._quotaWarned) {
                    this._quotaWarned = true;
                    this.showResetNotification('⚠️ Storage full: latest progress may not be saved. Try Export then Reset.');
                }
            }
        }
    }

    /**
     * Load data from local storage
     */
    loadFromStorage(key) {
        try {
            const stored = localStorage.getItem(key);
            if (stored) {
                const data = JSON.parse(stored);
                console.debug(`Loaded from storage: ${key}`, data.value);
                return data.value;
            }
        } catch (error) {
            console.warn('Failed to load from localStorage:', error);
        }
        return null;
    }

    /**
     * Setup auto-save functionality for all input elements
     */
    setupAutoSave() {
        console.log('DataManager: Setting up auto-save...');
        
        // Find all input elements that should be persisted
        const inputSelectors = [
            'input[type="text"]',
            'input[type="number"]',
            'input[type="email"]',
            'input[type="password"]',
            'input[type="search"]',
            'input[type="url"]',
            'input[type="tel"]',
            'input[type="date"]',
            'input[type="time"]',
            'input[type="datetime-local"]',
            'input[type="range"]',
            'input[type="color"]',
            'textarea',
            'select',
            'input[type="radio"]',
            'input[type="checkbox"]'
        ];

        const elements = document.querySelectorAll(inputSelectors.join(', '));
        console.log(`DataManager: Found ${elements.length} input elements on this page`);
        
        elements.forEach(element => {
            this.setupElementPersistence(element);
        });

        // Setup observer for dynamically added elements
        this.setupMutationObserver(inputSelectors);
        
        console.log('DataManager: Auto-save setup complete');
    }

    /**
     * True for inputs that are theme/UI chrome rather than reader work.
     * sphinx-design tab-sets keep their selection in hidden radio inputs;
     * persisting those would restore "last tab viewed", and tab open-state is
     * deliberately transient (see README, "Not persisted").
     */
    isUiChromeInput(element) {
        return !!element.closest('.sd-tab-set');
    }

    /**
     * Setup persistence for a specific element
     */
    setupElementPersistence(element) {
        if (this.isUiChromeInput(element)) return;

        const storageKey = this.getStorageKey(element);

        // One-time migration: radios used to be persisted per-id as a boolean.
        // That key is now stale (radios are keyed by group name), so drop it,
        // otherwise it could resurrect a wrong selection or inflate reset counts.
        if (element.type === 'radio' && element.name && element.id) {
            const legacyKey = `${this.storagePrefix}${window.location.pathname}_${element.id}`;
            if (legacyKey !== storageKey) localStorage.removeItem(legacyKey);
        }

        // Load saved value
        this.loadElementValue(element, storageKey);

        // Setup auto-save
        this.setupElementAutoSave(element, storageKey);
    }

    /**
     * Load and restore saved value for an element
     */
    loadElementValue(element, storageKey) {
        const savedValue = this.loadFromStorage(storageKey);
        if (savedValue === null) return;

        if (element.type === 'radio' && element.name) {
            // Group key holds the selected value; check only the matching radio.
            element.checked = (element.value === savedValue);
        } else if (element.type === 'checkbox' || element.type === 'radio') {
            element.checked = savedValue;
        } else if (element.tagName === 'SELECT' && element.multiple) {
            // Multi-selects store an array of selected option values.
            const chosen = new Set(Array.isArray(savedValue) ? savedValue : [savedValue]);
            Array.from(element.options).forEach(opt => { opt.selected = chosen.has(opt.value); });
        } else {
            element.value = savedValue;
        }

        // Fire BOTH input and change: range-slider value labels (and similar
        // live displays) listen on `input`, so dispatching only `change` left
        // the label stale after a reload while the thumb had already moved.
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Setup auto-save listeners for an element
     */
    setupElementAutoSave(element, storageKey) {
        const saveValue = () => {
            // Ignore saves triggered by the synthetic events that reset dispatches.
            if (this.suppressAutoSave) {
                return;
            }
            let value;
            if (element.type === 'radio' && element.name) {
                // Save the group's currently-selected value (or null if none),
                // so the store always reflects "exactly one", no stale booleans.
                const chosen = document.querySelector(
                    `input[type="radio"][name="${CSS.escape(element.name)}"]:checked`);
                value = chosen ? chosen.value : null;
            } else if (element.type === 'checkbox' || element.type === 'radio') {
                value = element.checked;
            } else if (element.tagName === 'SELECT' && element.multiple) {
                value = Array.from(element.selectedOptions).map(o => o.value);
            } else {
                value = element.value;
            }

            // Clear existing timeout
            if (this.saveTimeouts.has(storageKey)) {
                clearTimeout(this.saveTimeouts.get(storageKey));
            }
            
            // Set new timeout for delayed save
            const timeoutId = setTimeout(() => {
                this.saveToStorage(storageKey, value);
                this.saveTimeouts.delete(storageKey);
            }, this.saveDelay);
            
            this.saveTimeouts.set(storageKey, timeoutId);
        };

        // Add event listeners
        if (element.type === 'checkbox' || element.type === 'radio') {
            element.addEventListener('change', saveValue);
        } else {
            element.addEventListener('input', saveValue);
            element.addEventListener('change', saveValue);
        }
    }

    /**
     * Setup mutation observer to handle dynamically added elements
     */
    setupMutationObserver(inputSelectors) {
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Check if the node itself matches
                        inputSelectors.forEach(selector => {
                            if (node.matches && node.matches(selector)) {
                                this.setupElementPersistence(node);
                            }
                        });
                        
                        // Check children
                        const childInputs = node.querySelectorAll ? 
                            node.querySelectorAll(inputSelectors.join(', ')) : [];
                        childInputs.forEach(element => {
                            this.setupElementPersistence(element);
                        });
                    }
                });
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Cancel any debounced auto-save timers that haven't fired yet.
     * Called at the start of a reset so a pending save can't resurrect a key.
     */
    cancelPendingSaves() {
        this.saveTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
        this.saveTimeouts.clear();
    }

    /**
     * True when a storage key belongs to the current page. Form keys keep the
     * literal pathname (with slashes); code keys encode it with slashes turned
     * into underscores, so we test both encodings.
     */
    keyBelongsToCurrentPage(key) {
        const path = window.location.pathname;
        return key.includes(path) || key.includes(path.replace(/\//g, '_'));
    }

    /**
     * Single routine that decides which localStorage keys a reset should remove.
     * scope: 'page' (current page only) or 'book' (everything we manage).
     * Covers live prefixes (forms + code) AND legacy schemes, plus H5P for book.
     */
    collectKeysToRemove(scope) {
        const prefixes = [...this.managedPrefixes, ...this.legacyPrefixes];
        const keys = [];

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;

            // Never touch GitHub auth tokens.
            if (key.includes('github_token') || key.includes('github_username')) {
                continue;
            }

            // Bookkeeping, not user progress: the one-time migration flag from
            // thebe-code-persistence.js. If reset deletes it, the next page load
            // re-creates it, so every book reset reports "1 item" even when the
            // book is already empty. Skip it so the count reflects real data.
            if (key.startsWith('abm_book_codekey_migrated')) {
                continue;
            }

            const matchesPrefix = prefixes.some(p => key.startsWith(p));
            const isH5P = key.startsWith('h5p-') || key.includes('h5p') || key.startsWith('H5P');

            if (scope === 'book') {
                if (matchesPrefix || isH5P) {
                    keys.push(key);
                }
            } else { // 'page'
                // H5P keys aren't page-scoped, so only book reset clears them.
                if (matchesPrefix && this.keyBelongsToCurrentPage(key)) {
                    keys.push(key);
                }
            }
        }
        return keys;
    }

    /**
     * Remove a list of keys, returning how many actually existed (and so were
     * truly removed). This makes the "Cleared N items" notification truthful,
     * a 2nd reset finds nothing and reports 0.
     */
    removeKeys(keys) {
        let removed = 0;
        keys.forEach(key => {
            if (localStorage.getItem(key) !== null) {
                localStorage.removeItem(key);
                removed++;
            }
        });
        return removed;
    }

    /**
     * Get statistics about saved data
     */
    getStorageStats() {
        const pageUrl = window.location.pathname;
        let totalKeys = 0;
        let pageKeys = 0;
        let totalSize = 0;
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(this.storagePrefix)) {
                totalKeys++;
                const value = localStorage.getItem(key);
                totalSize += (key.length + value.length) * 2; // Rough size in bytes
                
                if (key.includes(pageUrl)) {
                    pageKeys++;
                }
            }
        }
        
        return {
            totalKeys,
            pageKeys,
            totalSize,
            readableSize: this.formatBytes(totalSize)
        };
    }

    /**
     * Format bytes to human readable format
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Reset data for current page only
     */
    resetCurrentPage() {
        // Stop any in-flight debounced saves and block autosave while we clear,
        // otherwise the synthetic events dispatched below re-create the keys.
        this.cancelPendingSaves();
        this.suppressAutoSave = true;
        // Recovery net: if the reset's reload never happens (tab backgrounded,
        // navigation blocked, an exception), re-enable autosave so saving isn't
        // dead for the rest of the session. No-op in the normal 800ms-reload case.
        setTimeout(() => { this.suppressAutoSave = false; }, 5000);

        // Remove all managed/legacy keys for this page (forms + code), counting
        // only the keys that actually existed.
        const removed = this.removeKeys(this.collectKeysToRemove('page'));

        // Clear all form elements on current page
        this.clearCurrentPageForms();

        // Reload so the cleared state is fully reflected: code cells revert to
        // their original source (no saved key -> original <pre>), and outputs,
        // form fields and H5P reset too. Arm the code-persistence module first so
        // the impending unload can't re-save (resurrect) the keys we just cleared,
        // and drop thebe's "leave site?" prompt since this reload is intentional.
        if (window.thebeCodePersistence) {
            window.thebeCodePersistence.prepareForResetReload();
        }
        window.onbeforeunload = null;

        this.showResetNotification(`✅ Current page reset! Cleared ${removed} items. Reloading…`);
        setTimeout(() => { window.location.reload(); }, 800);
    }

    /**
     * Reset data for entire book
     */
    resetEntireBook() {
        // Stop in-flight saves and block autosave while clearing (see resetCurrentPage).
        this.cancelPendingSaves();
        this.suppressAutoSave = true;
        // Recovery net: if the reset's reload never happens (tab backgrounded,
        // navigation blocked, an exception), re-enable autosave so saving isn't
        // dead for the rest of the session. No-op in the normal 800ms-reload case.
        setTimeout(() => { this.suppressAutoSave = false; }, 5000);

        // Remove ALL managed/legacy keys (forms + code) plus H5P, counting only
        // the keys that actually existed.
        const keysToRemove = this.collectKeysToRemove('book');
        const removed = this.removeKeys(keysToRemove);

        // Also clear sessionStorage for H5P
        if (window.sessionStorage) {
            const sessionKeysToRemove = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && (key.startsWith('h5p-') || key.includes('h5p') || key.startsWith('H5P'))) {
                    sessionKeysToRemove.push(key);
                }
            }
            sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));
        }

        // Clear all form elements on current page
        this.clearCurrentPageForms();

        if (removed > 0) {
            console.log('Reset entire book - cleared keys:', keysToRemove);
        }

        // Reload so this page comes back pristine (other pages revert on next
        // visit, since their keys are gone). Arm persistence so the unload can't
        // resurrect cleared keys, and drop thebe's "leave site?" prompt.
        if (window.thebeCodePersistence) {
            window.thebeCodePersistence.prepareForResetReload();
        }
        window.onbeforeunload = null;

        this.showResetNotification(
            `🔄 Entire book reset! Cleared ${removed} items. Reloading…`
        );
        setTimeout(() => { window.location.reload(); }, 800);
    }

    /**
     * Clear all form elements on the current page
     */
    clearCurrentPageForms() {
        const inputSelectors = [
            'input[type="text"]',
            'input[type="number"]',
            'input[type="email"]',
            'input[type="password"]',
            'input[type="search"]',
            'input[type="url"]',
            'input[type="tel"]',
            'input[type="date"]',
            'input[type="time"]',
            'input[type="datetime-local"]',
            'input[type="range"]',
            'input[type="color"]',
            'textarea',
            'select',
            'input[type="radio"]',
            'input[type="checkbox"]',
            // H5P and interactive elements
            '[data-h5p]',
            '[id*="h5p"]',
            '[class*="h5p"]',
            // Any element with data- attributes that might store state
            '[data-value]',
            '[data-selected]',
            '[data-checked]'
        ];

        const elements = document.querySelectorAll(inputSelectors.join(', '));

        elements.forEach(element => {
            try {
                // Never touch theme/UI chrome (e.g. sphinx-design tab radios):
                // unchecking them would visually break the tab-set until reload.
                if (this.isUiChromeInput(element)) return;
                if (element.type === 'checkbox' || element.type === 'radio') {
                    element.checked = false;
                } else if (element.tagName.toLowerCase() === 'select') {
                    if (element.multiple) {
                        Array.from(element.options).forEach(o => { o.selected = false; });
                    } else {
                        element.selectedIndex = 0;
                    }
                } else if (element.tagName.toLowerCase() === 'input' || element.tagName.toLowerCase() === 'textarea') {
                    element.value = '';
                } else {
                    // For H5P and other interactive elements, reset data attributes
                    if (element.hasAttribute('data-value')) {
                        element.removeAttribute('data-value');
                    }
                    if (element.hasAttribute('data-selected')) {
                        element.removeAttribute('data-selected');
                    }
                    if (element.hasAttribute('data-checked')) {
                        element.removeAttribute('data-checked');
                    }
                }
                
                // Trigger change events for all elements
                element.dispatchEvent(new Event('change', { bubbles: true }));
                element.dispatchEvent(new Event('input', { bubbles: true }));
                
                // For H5P elements, try to trigger their reset methods
                if (element.id && element.id.includes('h5p')) {
                    // Try to reset H5P content if methods are available
                    if (window.H5P && window.H5P.instances) {
                        window.H5P.instances.forEach(instance => {
                            if (instance.reset && typeof instance.reset === 'function') {
                                instance.reset();
                            }
                        });
                    }
                }
            } catch (error) {
                console.log('Could not reset element:', element, error);
            }
        });

        // Also clear any localStorage keys for the current page immediately
        this.clearCurrentPageLocalStorage();
    }

    /**
     * Clear localStorage for current page immediately
     */
    clearCurrentPageLocalStorage() {
        // Managed + legacy keys for this page (forms + code), via the shared routine.
        const keysToRemove = this.collectKeysToRemove('page');

        // Plus H5P keys (not page-scoped, but safe to clear when resetting a page).
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('h5p-') || key.includes('h5p') || key.startsWith('H5P'))) {
                if (!key.includes('github_token') && !key.includes('github_username')) {
                    keysToRemove.push(key);
                }
            }
        }

        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
            console.log('Cleared localStorage key:', key);
        });

        // Also clear sessionStorage for H5P
        if (window.sessionStorage) {
            const sessionKeysToRemove = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && (key.startsWith('h5p-') || key.includes('h5p') || key.startsWith('H5P'))) {
                    sessionKeysToRemove.push(key);
                }
            }
            sessionKeysToRemove.forEach(key => {
                sessionStorage.removeItem(key);
                console.log('Cleared sessionStorage key:', key);
            });
        }
    }

    /**
     * Show reset notification
     */
    showResetNotification(message) {
        // Remove any existing notification
        const existing = document.querySelector('.reset-notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.className = 'reset-notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 70px;
            left: 20px;
            z-index: 10002;
            background: #28a745;
            color: white;
            padding: 10px 15px;
            border-radius: 5px;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 4000);
    }
}

// Initialize the data manager when script loads
const dataManager = new DataManager();

// Make it globally available for debugging and manual operations
window.dataManager = dataManager;
