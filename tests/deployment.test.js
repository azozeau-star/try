const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const io = require('../docs/assets/socket.io.min.js');
const vm = require('node:vm');
const { scryptSync } = require('node:crypto');

test('deployment, authentication and persistence', async (t) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sami-test-'));
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const origin = 'https://example.github.io';
    const seed = {
        users: [{ id: 'seed-user', name: 'Existing User', email: 'existing@example.com', salt: 'seed-salt',
            passwordHash: scryptSync('existing-password', 'seed-salt', 64).toString('hex') }],
        chats: { 'seed-user': { displayName: 'Existing User', messages: [{ sender: 'user', text: 'Saved question' }] } },
        sessions: [{ tokenHash: 'old-session', expiresAt: Date.now() + 100000 }]
    };
    let child;
    async function start() {
        child = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(port), DATA_DIRECTORY: data, GROQ_API_KEY: '',
                ADMIN_PASSWORD: 'test-admin-password', STATIC_SITE_ORIGIN: origin + ',https://example.netlify.app',
                INITIAL_DATA_JSON: JSON.stringify(seed) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
            child.once('exit', () => { clearTimeout(timeout); reject(new Error('Server failed to start')); });
            child.stdout.on('data', (chunk) => {
                if (chunk.toString().includes('Server running')) { clearTimeout(timeout); resolve(); }
            });
        });
    }
    async function stop() {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
    }
    t.after(async () => {
        if (child && child.exitCode === null && !child.killed) await stop();
        fs.rmSync(data, { recursive: true, force: true });
    });
    await start();
    async function request(route, body, token, extraHeaders = {}) {
        const response = await fetch(base + route, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { response, body: await response.json() };
    }
    let token;
    await t.test('private seed restores passwords and history but discards old sessions', async () => {
        const saved = JSON.parse(fs.readFileSync(path.join(data, 'accounts.json'), 'utf8'));
        assert.deepEqual(saved.users, seed.users);
        assert.deepEqual(saved.chats, seed.chats);
        assert.deepEqual(saved.sessions, []);
        const login = await request('/api/login', { email: 'existing@example.com', password: 'existing-password' });
        assert.equal(login.response.status, 200);
        const user = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: login.body.sessionToken } });
        try {
            const history = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Seed history timed out')), 5000);
                user.once('chat_history', (messages) => { clearTimeout(timeout); resolve(messages); });
            });
            user.connect();
            assert.deepEqual(await history, seed.chats['seed-user'].messages);
        } finally { user.disconnect(); }
        await request('/api/logout', {}, login.body.sessionToken);
    });
    await t.test('public pages and assets resolve, including developer page', async () => {
        for (const route of ['/', '/developer/', '/client.js', '/config.js', '/assets/socket.io.min.js', '/assets/doctor-portrait.png']) {
            assert.equal((await fetch(base + route)).status, 200, route);
        }
        assert.equal((await request('/api/health')).body.status, 'ok');
    });
    await t.test('cross-origin signup and authenticated session', async () => {
        const result = await request('/api/signup', { name: 'Test User', email: 'test@example.com', password: 'testing-password' });
        assert.equal(result.response.status, 201);
        assert.equal(result.response.headers.get('access-control-allow-origin'), origin);
        token = result.body.sessionToken;
        assert.match(token, /^[a-f0-9]{64}$/);
        assert.equal(result.response.headers.get('set-cookie'), null);
        assert.equal((await request('/api/me', undefined, token)).body.user.email, 'test@example.com');
        assert.equal((await request('/api/me')).body.authenticated, false);
        assert.equal((await request('/api/me', undefined, 'invalid-token')).body.authenticated, false);
    });
    await t.test('login validates password and duplicate signup is rejected', async () => {
        assert.equal((await request('/api/login', { email: 'test@example.com', password: 'wrong' })).response.status, 401);
        assert.equal((await request('/api/login', { email: 'test@example.com', password: 'testing-password' })).body.role, 'user');
        assert.equal((await request('/api/signup', { name: 'Duplicate', email: 'test@example.com', password: 'testing-password' })).response.status, 409);
    });
    await t.test('same-origin cookie login works even with external origins configured', async () => {
        const result = await request('/api/login', { email: 'test@example.com', password: 'testing-password' }, undefined, { Origin: base });
        assert.equal(result.response.status, 200);
        const cookie = result.response.headers.get('set-cookie');
        assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'));
        assert.equal(result.body.sessionToken, undefined);
        assert.equal((await request('/api/me', undefined, undefined, { Origin: base, Cookie: cookie.split(';')[0] })).body.authenticated, true);
    });
    await t.test('CORS allows both configured origins and rejects others', async () => {
        const preflight = await fetch(base + '/api/login', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Method': 'POST' } });
        assert.equal(preflight.status, 204);
        assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
        assert.equal((await request('/api/me', undefined, token, { Origin: 'https://example.netlify.app' })).body.authenticated, true);
        assert.equal((await request('/api/me', undefined, token, { Origin: 'https://untrusted.example' })).response.status, 403);
        assert.equal((await fetch(base + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    });
    await t.test('developer login requires the configured password', async () => {
        assert.equal((await request('/api/admin/login', { password: 'wrong' })).response.status, 401);
        const admin = await request('/api/admin/login', { password: 'test-admin-password' });
        assert.equal(admin.body.role, 'admin');
        assert.equal((await request('/api/me', undefined, admin.body.sessionToken)).body.role, 'admin');
    });
    await t.test('user/developer WebSockets deliver live replies and persist chat history', async () => {
        const adminLogin = await request('/api/admin/login', { password: 'test-admin-password' });
        const user = io(base, { autoConnect: false, transports: ['websocket'], auth: { token } });
        const admin = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: adminLogin.body.sessionToken } });
        function event(socket, name) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for ' + name)), 5000);
                socket.once(name, (...args) => { clearTimeout(timeout); resolve(args[0]); });
            });
        }
        try {
            const initial = event(user, 'chat_history');
            user.connect(); await initial;
            const active = event(admin, 'active_users');
            admin.connect();
            const users = await active;
            assert.equal(users.length, 1);
            const userId = users[0].userId;
            let state = event(admin, 'admin_takeover_state');
            admin.emit('admin_set_takeover', { userId, enabled: true });
            assert.equal((await state).humanTakeover, true);
            let update = event(admin, 'update_admin_chat');
            user.emit('user_message', 'A test health question');
            assert.equal((await update).messages.at(-1).text, 'A test health question');
            const reply = event(user, 'receive_message');
            admin.emit('admin_message', { userId, text: 'Developer live response' });
            assert.equal((await reply).text, 'Developer live response');
            state = event(admin, 'admin_takeover_state');
            admin.emit('admin_set_takeover', { userId, enabled: false });
            assert.equal((await state).humanTakeover, false);
            const aiReply = event(user, 'receive_message');
            user.emit('user_message', 'Another health question');
            assert.equal((await aiReply).sender, 'AI'); // Missing-key fallback, no paid AI call.
            user.disconnect();
            const history = event(user, 'chat_history');
            user.connect();
            assert.ok((await history).some((message) => message.text === 'Developer live response'));
        } finally { user.disconnect(); admin.disconnect(); }
    });
    await t.test('shared browser client restores cross-domain sessions without cookies', async () => {
        const stored = new Map();
        const clientSource = fs.readFileSync(path.join(__dirname, '../docs/client.js'), 'utf8');
        function client() {
            const context = vm.createContext({
                window: { SAMI_BACKEND_URL: base }, location: { origin }, URL, AbortSignal,
                sessionStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
                fetch: (url, options) => {
                    assert.equal(options.credentials, 'omit');
                    return fetch(url, { ...options, headers: { ...options.headers, Origin: origin } });
                }, io: (url, options) => ({ url, options })
            });
            vm.runInContext(clientSource, context);
            return context.window.Sami;
        }
        const first = client();
        await first.request('/api/login', { email: 'test@example.com', password: 'testing-password' });
        assert.equal(stored.size, 1);
        const restored = client();
        assert.equal((await restored.request('/api/me')).authenticated, true);
        let auth;
        restored.createSocket().options.auth((value) => { auth = value; });
        assert.match(auth.token, /^[a-f0-9]{64}$/);
        await restored.request('/api/logout', {});
        assert.equal(stored.size, 0);
        assert.equal((await restored.request('/api/me')).authenticated, false);
    });
    await t.test('accounts and sessions survive a server restart on the same data directory', async () => {
        await stop();
        await start();
        assert.equal((await request('/api/me', undefined, token)).body.authenticated, true);
    });
    await t.test('logout revokes the server session', async () => {
        assert.equal((await request('/api/logout', {}, token)).body.success, true);
        assert.equal((await request('/api/me', undefined, token)).body.authenticated, false);
    });
});
