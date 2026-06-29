// Lightweight i18n — loads /i18n.json once, applies translations to elements
// marked `data-i18n="key"`, supports zh/en, persists via ClaudioAudio prefs.
(function () {
    let dict = null;
    let currentLocale = 'zh';
    const listeners = new Set();

    function detectInitial() {
        const pref = window.ClaudioAudio?.getPref?.('locale', null);
        if (pref === 'zh' || pref === 'en') return pref;
        const nav = (navigator.language || 'zh').toLowerCase();
        return nav.startsWith('en') ? 'en' : 'zh';
    }

    function t(key, fallback) {
        if (!dict) return fallback || key;
        return dict[currentLocale]?.[key] ?? dict.zh?.[key] ?? fallback ?? key;
    }

    function apply(root) {
        if (!dict) return;
        const target = root || document;
        target.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            const value = t(key);
            if (value) {
                if (el.hasAttribute('data-i18n-attr')) {
                    el.setAttribute(el.dataset.i18nAttr, value);
                } else {
                    el.textContent = value;
                }
            }
        });
        // Handle placeholder via data-i18n-placeholder
        target.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
        });
        // Handle aria-label via data-i18n-aria
        target.querySelectorAll('[data-i18n-aria]').forEach(el => {
            el.setAttribute('aria-label', t(el.dataset.i18nAria));
        });
        document.documentElement.lang = currentLocale === 'en' ? 'en' : 'zh-CN';
    }

    function setLocale(locale) {
        if (locale !== 'zh' && locale !== 'en') return;
        currentLocale = locale;
        try { window.ClaudioAudio?.setPref?.('locale', locale); } catch {}
        apply();
        listeners.forEach(fn => { try { fn(locale); } catch {} });
    }

    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    async function init() {
        try {
            const res = await fetch('/i18n.json');
            dict = await res.json();
        } catch (e) {
            console.warn('[i18n] dict load failed:', e.message);
            dict = { zh: {}, en: {} };
        }
        currentLocale = detectInitial();
        apply();
    }

    window.ClaudioI18n = { init, t, setLocale, onChange,
        get locale() { return currentLocale; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
