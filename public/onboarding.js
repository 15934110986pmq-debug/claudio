// onboarding.js — first-run taste wizard. Auto-opens for authenticated users
// who haven't onboarded; can be re-opened via the ••• menu's "Edit my taste".
(function () {
    let modal, form, prevBtn, nextBtn, skipBtn, finishBtn, errBox;
    const steps = []; // DOM sections, populated on init
    let currentStep = 0;
    const state = { love: [], avoid: [], mood: [] };
    let prefilled = null;

    function init() {
        modal      = document.getElementById('onboarding-modal');
        if (!modal) return;
        form       = document.getElementById('onboarding-form');
        prevBtn    = document.getElementById('onb-back');
        nextBtn    = document.getElementById('onb-next');
        skipBtn    = document.getElementById('onb-skip');
        finishBtn  = document.getElementById('onb-finish');
        errBox     = document.getElementById('onboarding-error');
        steps.push(...modal.querySelectorAll('.onb-step'));

        // Wire chip-style inputs (comma or Enter to add a chip)
        wireChips('onb-love',  'onb-love-chips',  state.love,  20);
        wireChips('onb-avoid', 'onb-avoid-chips', state.avoid, 20);
        wireChips('onb-mood',  'onb-mood-chips',  state.mood,  8);

        nextBtn.addEventListener('click', () => goTo(currentStep + 1));
        prevBtn.addEventListener('click', () => goTo(currentStep - 1));
        skipBtn.addEventListener('click', () => {
            if (currentStep < steps.length - 1) goTo(currentStep + 1);
            else save();
        });
        form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

        // Wire menu reopen — delegates on body to catch any view's ••• menu
        document.body.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action="taste"]');
            if (item) open(true);
        });

        // Auto-open check
        checkAndAutoOpen();
    }

    async function checkAndAutoOpen() {
        try {
            const res = await fetch('/api/onboarding/state');
            const data = await res.json();
            if (!data.user) return;          // anonymous — never auto-open
            if (data.user.onboarded) return; // already done
            prefilled = data.taste;
            open(false);
        } catch (err) {
            console.warn('[onboarding] state check failed:', err.message);
        }
    }

    async function open(asEdit) {
        // If editing, fetch fresh state to prefill
        if (asEdit) {
            try {
                const res = await fetch('/api/onboarding/state');
                const data = await res.json();
                if (!data.user) return; // anon users can't edit taste
                prefilled = data.taste;
            } catch { /* continue with empty form */ }
        }
        // Reset chip state
        state.love.length  = 0;
        state.avoid.length = 0;
        state.mood.length  = 0;
        if (prefilled) prefillForm(prefilled);
        const closeBtn = document.getElementById('onboarding-close');
        if (closeBtn) closeBtn.hidden = !asEdit;
        currentStep = 0;
        renderStep();
        modal.hidden = false;
    }

    function prefillForm(taste) {
        if (!taste) return;
        state.love.push(...(taste.artistsLove  || []));
        state.avoid.push(...(taste.artistsAvoid || []));
        state.mood.push(...(taste.moodSeeds    || []));
        renderChips('onb-love-chips',  state.love);
        renderChips('onb-avoid-chips', state.avoid);
        renderChips('onb-mood-chips',  state.mood);
        const tp = taste.timePrefs || {};
        for (const k of ['morning', 'afternoon', 'evening', 'night']) {
            const el = document.getElementById('onb-' + k);
            if (el) el.value = tp[k] || '';
        }
        const city = document.getElementById('onb-city');
        if (city) city.value = taste.weatherCity || '';
    }

    function wireChips(inputId, chipsId, arr, max) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = input.value.trim().replace(/,$/, '');
                if (val && !arr.includes(val) && arr.length < max) {
                    arr.push(val);
                    renderChips(chipsId, arr);
                }
                input.value = '';
            } else if (e.key === 'Backspace' && !input.value && arr.length) {
                arr.pop();
                renderChips(chipsId, arr);
            }
        });
        // Also commit on blur
        input.addEventListener('blur', () => {
            const val = input.value.trim();
            if (val && !arr.includes(val) && arr.length < max) {
                arr.push(val);
                renderChips(chipsId, arr);
            }
            input.value = '';
        });
    }

    function renderChips(chipsId, arr) {
        const host = document.getElementById(chipsId);
        if (!host) return;
        host.innerHTML = '';
        for (const tag of arr) {
            const chip = document.createElement('span');
            chip.className = 'onb-chip';
            chip.textContent = tag;
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'onb-chip-x';
            x.setAttribute('aria-label', 'Remove ' + tag);
            x.textContent = '×';
            x.addEventListener('click', () => {
                const idx = arr.indexOf(tag);
                if (idx >= 0) arr.splice(idx, 1);
                renderChips(chipsId, arr);
            });
            chip.appendChild(x);
            host.appendChild(chip);
        }
    }

    function goTo(idx) {
        if (idx < 0 || idx >= steps.length) return;
        currentStep = idx;
        renderStep();
    }

    function renderStep() {
        steps.forEach((s, i) => s.classList.toggle('is-active', i === currentStep));
        modal.querySelectorAll('.onb-dot').forEach((d, i) => d.classList.toggle('is-active', i <= currentStep));
        prevBtn.hidden   = currentStep === 0;
        nextBtn.hidden   = currentStep === steps.length - 1;
        finishBtn.hidden = currentStep !== steps.length - 1;
    }

    async function save() {
        errBox.hidden = true;
        nextBtn.disabled = true;
        finishBtn.disabled = true;
        skipBtn.disabled = true;
        const body = {
            artistsLove:  [...state.love],
            artistsAvoid: [...state.avoid],
            moodSeeds:    [...state.mood],
            timePrefs: {
                morning:   document.getElementById('onb-morning')?.value   || '',
                afternoon: document.getElementById('onb-afternoon')?.value || '',
                evening:   document.getElementById('onb-evening')?.value   || '',
                night:     document.getElementById('onb-night')?.value     || ''
            },
            weatherCity: document.getElementById('onb-city')?.value || ''
        };
        try {
            const res = await fetch('/api/onboarding/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'save failed');
            modal.hidden = true;
        } catch (err) {
            errBox.textContent = err.message;
            errBox.hidden = false;
        } finally {
            nextBtn.disabled = false;
            finishBtn.disabled = false;
            skipBtn.disabled = false;
        }
    }

    // Wire close button and backdrop click
    document.addEventListener('click', (e) => {
        if (e.target.id === 'onboarding-close' || e.target.id === 'onboarding-backdrop') {
            if (modal) modal.hidden = true;
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
