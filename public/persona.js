// persona.js — lets authenticated users pick or author a DJ persona.
(function () {
    let modal, pickView, editorView;
    let listHost, saveBtn, cancelBtn, createBtn, errBox;
    let editorNameEl, editorPromptEl, editorSaveBtn, editorCancelBtn, editorDeleteBtn;
    let personas = [];   // [{id, name, description, builtin}]
    let selected = null; // currently selected id in the pick view
    let editingId = null; // numeric DB id when editing an existing custom persona (null = new)

    function init() {
        modal = document.getElementById('persona-modal');
        if (!modal) return;

        pickView       = document.getElementById('persona-pick-view');
        editorView     = document.getElementById('persona-editor');
        listHost       = document.getElementById('persona-list');
        saveBtn        = document.getElementById('persona-save');
        cancelBtn      = document.getElementById('persona-cancel');
        createBtn      = document.getElementById('persona-create');
        errBox         = document.getElementById('persona-error');

        editorNameEl   = document.getElementById('persona-name');
        editorPromptEl = document.getElementById('persona-prompt');
        editorSaveBtn  = document.getElementById('persona-editor-save');
        editorCancelBtn= document.getElementById('persona-editor-cancel');
        editorDeleteBtn= document.getElementById('persona-editor-delete');

        saveBtn.addEventListener('click', save);
        cancelBtn.addEventListener('click', close);
        createBtn.addEventListener('click', () => openEditor(null));
        editorSaveBtn.addEventListener('click', saveCustom);
        editorCancelBtn.addEventListener('click', () => showPickView());
        editorDeleteBtn.addEventListener('click', deleteCustom);

        document.getElementById('persona-close')?.addEventListener('click', close);
        document.getElementById('persona-backdrop')?.addEventListener('click', close);

        document.body.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action="persona"]');
            if (item) open();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) close();
        });
    }

    async function open() {
        errBox.hidden = true;
        listHost.innerHTML = '<p style="opacity:0.5;font-size:0.875rem;">Loading…</p>';
        modal.hidden = false;
        showPickView();

        try {
            const data = await fetch('/api/personas').then(r => r.json());
            personas = data.personas || [];
            selected = data.current || null;
            renderList();
        } catch (err) {
            showError('Could not load personas. Try again.');
        }
    }

    function close() {
        modal.hidden = true;
        listHost.innerHTML = '';
        personas = [];
        selected = null;
        editingId = null;
        errBox.hidden = true;
    }

    function showPickView() {
        pickView.hidden = false;
        editorView.hidden = true;
        errBox.hidden = true;
    }

    function showEditorView() {
        pickView.hidden = true;
        editorView.hidden = false;
        errBox.hidden = true;
    }

    function renderList() {
        listHost.innerHTML = '';
        personas.forEach(p => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0';

            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;align-items:center;gap:0.75rem;cursor:pointer;padding:0.5rem 0.5rem;border-radius:6px;transition:background 0.15s;flex:1;min-width:0';
            lbl.addEventListener('mouseenter', () => { lbl.style.background = 'rgba(255,255,255,0.05)'; });
            lbl.addEventListener('mouseleave', () => { lbl.style.background = ''; });

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'persona';
            radio.value = p.id;
            radio.checked = (p.id === selected) || (!selected && p.id === 'default');
            radio.style.cssText = 'width:1rem;height:1rem;accent-color:var(--color-accent,#c9a96e);flex-shrink:0;cursor:pointer';
            radio.addEventListener('change', () => { selected = p.id; });

            const meta = document.createElement('span');
            meta.style.cssText = 'display:flex;flex-direction:column;gap:0.15rem;min-width:0';
            const nameEl = document.createElement('span');
            nameEl.textContent = p.name;
            nameEl.style.cssText = 'font-weight:500;font-size:0.9375rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
            const descEl = document.createElement('span');
            descEl.textContent = p.description;
            descEl.style.cssText = 'font-size:0.8125rem;opacity:0.55;';
            meta.appendChild(nameEl);
            meta.appendChild(descEl);

            lbl.appendChild(radio);
            lbl.appendChild(meta);
            row.appendChild(lbl);

            // Edit / Delete buttons for custom personas only
            if (!p.builtin) {
                const numId = parseInt(p.id.slice(7), 10);

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.textContent = t('persona.edit') || 'Edit';
                editBtn.style.cssText = 'font-size:0.75rem;padding:3px 8px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:inherit;border-radius:4px;cursor:pointer;flex-shrink:0';
                editBtn.addEventListener('click', () => openEditor(numId));
                row.appendChild(editBtn);
            }

            listHost.appendChild(row);
        });
    }

    async function openEditor(numId) {
        editingId = numId;
        editorNameEl.value = '';
        editorPromptEl.value = '';
        editorDeleteBtn.hidden = !numId;

        if (numId) {
            try {
                const data = await fetch(`/api/personas/custom/${numId}`).then(r => r.json());
                if (data.persona) {
                    editorNameEl.value = data.persona.name || '';
                    editorPromptEl.value = data.persona.prompt_md || '';
                }
            } catch {
                showError('Could not load persona for editing.');
                return;
            }
        }

        showEditorView();
        editorNameEl.focus();
    }

    async function saveCustom() {
        const name = editorNameEl.value.trim();
        const promptMd = editorPromptEl.value.trim();
        if (!name) { showError('Persona name is required.'); return; }
        if (!promptMd) { showError('Prompt is required.'); return; }

        // Auth check
        let me;
        try { me = await fetch('/api/auth/me').then(r => r.json()); } catch { me = {}; }
        if (!me.user) {
            showError('Sign in first — custom personas need an account.');
            return;
        }

        editorSaveBtn.disabled = true;
        editorSaveBtn.textContent = 'Saving…';
        try {
            const body = { name, promptMd };
            if (editingId) body.id = editingId;
            const res = await fetch('/api/personas/custom', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'save failed');

            // Refresh list
            showPickView();
            listHost.innerHTML = '<p style="opacity:0.5;font-size:0.875rem;">Loading…</p>';
            const listData = await fetch('/api/personas').then(r => r.json());
            personas = listData.personas || [];
            selected = listData.current || selected;
            renderList();
        } catch (err) {
            showError(err.message);
        } finally {
            editorSaveBtn.disabled = false;
            editorSaveBtn.textContent = t('persona.editor.save') || 'Save persona';
        }
    }

    async function deleteCustom() {
        if (!editingId) return;
        if (!confirm('Delete this custom persona?')) return;

        try {
            const res = await fetch(`/api/personas/custom/${editingId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'delete failed');

            showPickView();
            listHost.innerHTML = '<p style="opacity:0.5;font-size:0.875rem;">Loading…</p>';
            const listData = await fetch('/api/personas').then(r => r.json());
            personas = listData.personas || [];
            selected = listData.current || null;
            renderList();
        } catch (err) {
            showError(err.message);
        }
    }

    async function save() {
        errBox.hidden = true;
        if (!selected) { showError('Pick a persona first.'); return; }

        // Check auth
        let me;
        try { me = await fetch('/api/auth/me').then(r => r.json()); } catch { me = {}; }
        if (!me.user) {
            showError('Sign in first — persona choice needs an account to save.');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        let res;
        try {
            res = await fetch('/api/persona', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persona: selected })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'save failed');
            close();
        } catch (err) {
            // Special case: auth lost mid-session. Funnel to sign-in.
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
            saveBtn.disabled = false;
            saveBtn.textContent = t('persona.save') || 'Save';
        }
    }

    function showError(msg) {
        if (!errBox) return;
        errBox.textContent = msg;
        errBox.hidden = false;
    }

    function t(key) {
        return window.ClaudioI18n?.t?.(key) || null;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
