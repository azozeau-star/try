/* Shared connection and session handling for the user and developer pages. */
(() => {
    const base = (window.SAMI_BACKEND_URL || location.origin).replace(/\/+$/, '');
    const crossOrigin = new URL(base).origin !== location.origin;
    const sessionKey = 'sami-session:' + base;
    let token = '';
    try { token = crossOrigin ? sessionStorage.getItem(sessionKey) || '' : ''; } catch {}

    function clearSession() {
        token = '';
        try { sessionStorage.removeItem(sessionKey); } catch {}
    }
    async function request(url, body) {
        let response;
        try {
            response = await fetch(base + url, {
                method: body === undefined ? 'GET' : 'POST',
                credentials: crossOrigin ? 'omit' : 'same-origin',
                headers: {
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...(token ? { Authorization: 'Bearer ' + token } : {})
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(60000)
            });
        } catch {
            throw new Error('تعذّر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
        }
        if (!(response.headers.get('Content-Type') || '').includes('application/json')) {
            throw new Error('الخادم غير متصل بالموقع. تحقق من رابط الخادم في إعدادات النشر.');
        }
        const result = await response.json();
        if (!response.ok) {
            if (response.status === 401) clearSession();
            throw new Error(result.error || 'تعذّر إكمال الطلب.');
        }
        if (crossOrigin && result.sessionToken) {
            token = result.sessionToken;
            // Only keep cross-domain sessions in this tab, never localStorage.
            try { sessionStorage.setItem(sessionKey, token); } catch {}
        }
        if (url === '/api/logout' || (url === '/api/me' && !result.authenticated)) clearSession();
        return result;
    }
    function createSocket() {
        return io(base, {
            autoConnect: false,
            withCredentials: !crossOrigin,
            auth: (callback) => callback(token ? { token } : {})
        });
    }
    window.Sami = { request, createSocket };
})();
