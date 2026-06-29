(function () {
    let modal, toggle, urlRow, urlInput, copyBtn, errBox;

    function init() {
        modal    = document.getElementById('share-modal');
        if (!modal) return;
        toggle   = document.getElementById('share-public-toggle');
        urlRow   = document.getElementById('share-url-row');
        urlInput = document.getElementById('share-url');
        copyBtn  = document.getElementById('share-copy');
        errBox   = document.getElementById('share-error');

        toggle.addEventListener('change', save);
        copyBtn.addEventListener('click', copy);
        document.getElementById('share-close').addEventListener('click', closeModal);
        document.getElementById('share-backdrop').addEventListener('click', closeModal);

        document.body.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action="share-taste"]');
            if (item) openModal();
        });
    }

    async function openModal() {
        const me = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}));
        if (!me.user) {
            const authModal = document.getElementById('auth-modal');
            if (authModal) authModal.hidden = false;
            return;
        }
        const shareState = await fetch('/api/taste/share/state').then(r => r.json()).catch(() => ({ public: false }));
        toggle.checked = !!shareState.public;
        renderUrl(shareState.url);
        errBox.hidden = true;
        modal.hidden = false;
    }

    function closeModal() { modal.hidden = true; }

    async function save() {
        errBox.hidden = true;
        toggle.disabled = true;
        let res;
        try {
            res = await fetch('/api/taste/share', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ public: toggle.checked })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'failed');
            renderUrl(data.url);
        } catch (err) {
            // Special case: auth lost mid-session or never had it. Don't strand the
            // user with an unhelpful error — funnel them into the sign-in flow.
            if (/login required|401/i.test(err.message) || res?.status === 401) {
                toggle.checked = false;
                if (modal) modal.hidden = true;
                const authModal = document.getElementById('auth-modal');
                if (authModal) {
                    authModal.hidden = false;
                    setTimeout(() => document.getElementById('auth-email')?.focus(), 50);
                }
                return;
            }
            errBox.textContent = err.message;
            errBox.hidden = false;
            toggle.checked = !toggle.checked; // revert
        } finally {
            toggle.disabled = false;
        }
    }

    function renderUrl(url) {
        if (url) {
            urlRow.hidden = false;
            urlInput.value = url;
        } else {
            urlRow.hidden = true;
            urlInput.value = '';
        }
    }

    async function copy() {
        const url = urlInput.value;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            copyBtn.textContent = '✓';
            setTimeout(() => {
                copyBtn.textContent = (window.ClaudioI18n && window.ClaudioI18n.t && window.ClaudioI18n.t('share.copy')) || 'Copy';
            }, 1400);
        } catch {
            urlInput.select();
            document.execCommand('copy');
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
