// Handle the "Enable notifications" menu item — request browser permission,
// subscribe to the SW push, POST the subscription to the server.
(function () {
    async function toggle() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            alert('Notifications not supported in this browser.');
            return;
        }
        // Need login first — push subs live per user
        const me = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}));
        if (!me.user) {
            document.getElementById('auth-modal').hidden = false;
            return;
        }

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();

        if (sub) {
            // Already subscribed — unsubscribe
            try {
                await fetch('/api/push/unsubscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: sub.endpoint })
                });
            } catch (e) {
                console.warn('[push] server unsubscribe failed:', e.message);
            }
            await sub.unsubscribe();
            updateMenuLabel(false);
            return;
        }

        // Request permission
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;

        // Get the public VAPID key
        const { publicKey } = await fetch('/api/push/vapid-key').then(r => r.json());
        if (!publicKey) { alert('Server not push-configured.'); return; }

        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
        });

        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub.toJSON())
        });
        updateMenuLabel(true);
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function updateMenuLabel(subscribed) {
        const items = document.querySelectorAll('.more-item[data-action="notifications"] .more-text');
        const key = subscribed ? 'nav.notifications_off' : 'nav.notifications';
        const text = window.ClaudioI18n?.t?.(key) || (subscribed ? 'Disable notifications' : 'Enable notifications');
        items.forEach(el => {
            el.textContent = text;
            el.dataset.i18n = key;
        });
    }

    async function refreshLabel() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            updateMenuLabel(!!sub);
        } catch (e) {
            console.warn('[push] refreshLabel failed:', e.message);
        }
    }

    document.body.addEventListener('click', (e) => {
        const item = e.target.closest('.more-item[data-action="notifications"]');
        if (item) toggle();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refreshLabel);
    } else {
        refreshLabel();
    }
})();
