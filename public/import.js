// import.js — paste free-form text → LLM extracts artists → user reviews → merges.
(function () {
    let modal, textArea, preview, chipsHost, extractBtn, mergeBtn, cancelBtn, errBox;
    let candidates = []; // [{ name, selected: true }]

    function init() {
        modal      = document.getElementById('import-modal');
        if (!modal) return;
        textArea   = document.getElementById('import-text');
        preview    = document.getElementById('import-preview');
        chipsHost  = document.getElementById('import-chips');
        extractBtn = document.getElementById('import-extract');
        mergeBtn   = document.getElementById('import-merge');
        cancelBtn  = document.getElementById('import-cancel');
        errBox     = document.getElementById('import-error');

        extractBtn.addEventListener('click', extract);
        mergeBtn.addEventListener('click', merge);
        cancelBtn.addEventListener('click', close);
        document.getElementById('import-close')?.addEventListener('click', close);
        document.getElementById('import-backdrop')?.addEventListener('click', close);

        document.body.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action="import"]');
            if (item) open();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) close();
        });
    }

    async function open() {
        // Auth check before opening — if anon, redirect them to sign in
        try {
            const me = await fetch('/api/auth/me').then(r => r.json());
            if (!me.user) {
                const authModal = document.getElementById('auth-modal');
                if (authModal) authModal.hidden = false;
                return;
            }
        } catch { /* fall through — open anyway */ }
        reset();
        modal.hidden = false;
        setTimeout(() => textArea?.focus(), 50);
    }

    function close() {
        modal.hidden = true;
        reset();
    }

    function reset() {
        if (textArea) textArea.value = '';
        if (preview) preview.hidden = true;
        if (chipsHost) chipsHost.innerHTML = '';
        if (errBox) errBox.hidden = true;
        if (extractBtn) { extractBtn.hidden = false; extractBtn.disabled = false; extractBtn.textContent = t('import.extract') || 'Extract artists →'; }
        if (mergeBtn) mergeBtn.hidden = true;
        candidates = [];
    }

    async function extract() {
        const text = textArea?.value?.trim();
        if (!text) { showError('Paste something first.'); return; }
        errBox.hidden = true;
        extractBtn.disabled = true;
        extractBtn.textContent = 'Extracting…';
        try {
            const res = await fetch('/api/import/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'extraction failed');
            candidates = (data.artists || []).map(name => ({ name, selected: true }));
            if (candidates.length === 0) {
                showError('Nothing recognizable in that paste. Try a different source.');
                extractBtn.disabled = false;
                extractBtn.textContent = t('import.extract') || 'Extract artists →';
                return;
            }
            renderPreview();
            extractBtn.hidden = true;
            mergeBtn.hidden = false;
        } catch (err) {
            showError(err.message);
            extractBtn.disabled = false;
            extractBtn.textContent = t('import.extract') || 'Extract artists →';
        }
    }

    function renderPreview() {
        const label = preview.querySelector('.import-preview-label');
        if (label) {
            const tpl = t('import.found') || 'Found N artists. Uncheck any you don\'t want to import:';
            label.textContent = tpl.replace('N', String(candidates.length));
        }
        preview.hidden = false;
        chipsHost.innerHTML = '';
        candidates.forEach((c, i) => {
            const chip = document.createElement('label');
            chip.className = 'import-chip';
            chip.dataset.idx = String(i);
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = c.selected;
            cb.addEventListener('change', () => {
                c.selected = cb.checked;
                chip.classList.toggle('is-off', !cb.checked);
            });
            const txt = document.createElement('span');
            txt.textContent = c.name;
            chip.appendChild(cb);
            chip.appendChild(txt);
            chipsHost.appendChild(chip);
        });
    }

    async function merge() {
        const selected = candidates.filter(c => c.selected).map(c => c.name);
        if (selected.length === 0) { showError('Select at least one artist to add.'); return; }
        errBox.hidden = true;
        mergeBtn.disabled = true;
        mergeBtn.textContent = 'Merging…';
        let res;
        try {
            res = await fetch('/api/import/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ artists: selected })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'merge failed');
            close();
        } catch (err) {
            // Special case: auth lost mid-session or never had it. Funnel to sign-in.
            if (/login required|401/i.test(err.message) || res?.status === 401) {
                if (modal) modal.hidden = true;
                const authModal = document.getElementById('auth-modal');
                if (authModal) {
                    authModal.hidden = false;
                    setTimeout(() => document.getElementById('auth-email')?.focus(), 50);
                }
                return;
            }
            showError(err.message);
            mergeBtn.disabled = false;
            mergeBtn.textContent = t('import.merge') || 'Add to my taste';
        }
    }

    function showError(msg) {
        if (!errBox) return;
        errBox.textContent = msg;
        errBox.hidden = false;
    }

    // Thin i18n wrapper — delegates to ClaudioI18n if present.
    function t(key) {
        return window.ClaudioI18n?.t?.(key) || null;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
