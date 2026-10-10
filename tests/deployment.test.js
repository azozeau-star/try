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
            passwordHash: scryptSync('existing-password', 'seed-salt', 64).toString('hex'), lastLoginAt: Date.now() },
            { id: 'inactive-user', name: 'Inactive User', email: 'inactive@example.com', salt: 'inactive-salt',
                passwordHash: scryptSync('inactive-password', 'inactive-salt', 64).toString('hex'),
                lastLoginAt: Date.now() - 15 * 24 * 60 * 60 * 1000 }],
        chats: {
            'seed-user': { displayName: 'Existing User', messages: [{ sender: 'user', text: 'Saved question' }] },
            'inactive-user': { displayName: 'Inactive User', messages: [{ sender: 'user', text: 'Older saved question' }] }
        },
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
    await t.test('developer can reply after sign-out and user receives saved replies on return', async () => {
        const account = await request('/api/signup', { name: 'Offline History', email: 'history@example.com', password: 'history-password' });
        const accountId = account.body.user.id;
        const adminLogin = await request('/api/admin/login', { password: 'test-admin-password' });
        const admin = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: adminLogin.body.sessionToken } });
        const user = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: account.body.sessionToken } });
        let returningToken;
        function event(socket, name) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for ' + name)), 5000);
                socket.once(name, (value) => { clearTimeout(timeout); resolve(value); });
            });
        }
        try {
            let list = event(admin, 'saved_chats');
            admin.connect();
            const initial = await list;
            assert.equal(initial.find((entry) => entry.userId === 'seed-user').online, false);
            assert.equal(initial.find((entry) => entry.userId === accountId).online, false);
            assert.equal(initial[0].messages, undefined); // History is sent only when selected.
            list = event(admin, 'saved_chats');
            const connected = event(user, 'chat_history');
            user.connect();
            await connected;
            assert.equal((await list).find((entry) => entry.userId === accountId).online, true);
            const state = event(admin, 'admin_takeover_state');
            admin.emit('admin_set_takeover', { userId: accountId, enabled: true });
            assert.equal((await state).humanTakeover, true);
            const update = event(admin, 'update_admin_chat');
            user.emit('user_message', 'Keep this saved conversation');
            assert.equal((await update).accountId, accountId);
            const reply = event(user, 'receive_message');
            admin.emit('admin_message', { userId: accountId, text: 'Saved developer reply' });
            assert.equal((await reply).text, 'Saved developer reply');
            list = event(admin, 'saved_chats');
            await request('/api/logout', {}, account.body.sessionToken);
            const offline = (await list).find((entry) => entry.userId === accountId);
            assert.equal(offline.online, false);
            assert.equal(offline.messageCount, 2);
            let history = event(admin, 'admin_chat_history');
            admin.emit('load_admin_chat', accountId);
            const saved = await history;
            assert.equal(saved.online, false);
            assert.deepEqual(saved.messages.map((message) => message.text), ['Keep this saved conversation', 'Saved developer reply']);
            const offlineUpdate = event(admin, 'update_admin_chat');
            const acknowledged = await new Promise((resolve, reject) => {
                admin.timeout(5000).emit('admin_message', { userId: accountId, text: 'Reply while you are away' },
                    (error, result) => error ? reject(error) : resolve(result));
            });
            assert.deepEqual(acknowledged, { success: true });
            const updated = await offlineUpdate;
            assert.equal(updated.summary.online, false);
            assert.equal(updated.summary.messageCount, 3);
            assert.equal(updated.messages[2].text, 'Reply while you are away');
            const persisted = JSON.parse(fs.readFileSync(path.join(data, 'accounts.json'), 'utf8'));
            assert.deepEqual(persisted.chats[accountId].messages, updated.messages);
            admin.disconnect();
            list = event(admin, 'saved_chats');
            admin.connect();
            assert.equal((await list).find((entry) => entry.userId === accountId).online, false);
            history = event(admin, 'admin_chat_history');
            admin.emit('load_admin_chat', accountId);
            assert.deepEqual((await history).messages, updated.messages);
            const login = await request('/api/login', { email: 'history@example.com', password: 'history-password' });
            assert.equal(login.response.status, 200);
            returningToken = login.body.sessionToken;
            user.auth = { token: returningToken };
            const returnedHistory = event(user, 'chat_history');
            user.connect();
            assert.deepEqual(await returnedHistory, updated.messages);
        } finally {
            user.disconnect(); admin.disconnect();
            if (returningToken) await request('/api/logout', {}, returningToken);
            await request('/api/logout', {}, adminLogin.body.sessionToken);
        }
    });
    await t.test('saved developer conversations are unavailable to users and anonymous sockets', async () => {
        const anonymous = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false });
        const user = io(base, { autoConnect: false, transports: ['websocket'], auth: { token } });
        try {
            const rejected = new Promise((resolve) => anonymous.once('connect_error', resolve));
            anonymous.connect();
            assert.match((await rejected).message, /Authentication/);
            const connected = new Promise((resolve) => user.once('chat_history', resolve));
            let exposed = false;
            user.on('saved_chats', () => { exposed = true; });
            user.on('admin_chat_history', () => { exposed = true; });
            user.connect(); await connected;
            user.emit('load_admin_chat', 'seed-user');
            user.emit('admin_set_user_visibility', { userId: 'seed-user', hidden: true });
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(exposed, false);
            const disk = JSON.parse(fs.readFileSync(path.join(data, 'accounts.json'), 'utf8'));
            assert.notEqual(disk.users.find((entry) => entry.id === 'seed-user').developerHidden, true);
        } finally { anonymous.disconnect(); user.disconnect(); }
    });
    await t.test('inactivity and manual hiding change only developer visibility', async () => {
        const adminLogin = await request('/api/admin/login', { password: 'test-admin-password' });
        const admin = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: adminLogin.body.sessionToken } });
        let user;
        let userToken;
        const expectedHistory = [...seed.chats['inactive-user'].messages];
        function event(socket, name) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for ' + name)), 5000);
                socket.once(name, (value) => { clearTimeout(timeout); resolve(value); });
            });
        }
        function visibility(hidden) {
            return new Promise((resolve, reject) => {
                admin.timeout(3000).emit('admin_set_user_visibility', { userId: 'inactive-user', hidden }, (error, result) => {
                    if (error) reject(error); else resolve(result);
                });
            });
        }
        try {
            let list = event(admin, 'developer_chats');
            admin.connect();
            const initial = await list;
            assert.equal(initial.visible.some((entry) => entry.userId === 'inactive-user'), false);
            assert.equal(initial.hidden.find((entry) => entry.userId === 'inactive-user').hiddenReason, 'inactive');
            list = event(admin, 'developer_chats');
            const login = await request('/api/login', { email: 'inactive@example.com', password: 'inactive-password' });
            userToken = login.body.sessionToken;
            assert.equal(login.response.status, 200);
            assert.equal((await list).visible.some((entry) => entry.userId === 'inactive-user'), true);
            user = io(base, { autoConnect: false, transports: ['websocket'], auth: { token: userToken } });
            const history = event(user, 'chat_history');
            const onlineList = event(admin, 'developer_chats');
            user.connect();
            assert.deepEqual(await history, seed.chats['inactive-user'].messages);
            await onlineList;
            const takeover = event(admin, 'admin_takeover_state');
            admin.emit('admin_set_takeover', { userId: 'inactive-user', enabled: true });
            assert.equal((await takeover).humanTakeover, true);
            list = event(admin, 'developer_chats');
            assert.equal((await visibility(true)).success, true);
            assert.equal((await list).visible.some((entry) => entry.userId === 'inactive-user'), false);
            const hiddenUpdate = event(admin, 'update_admin_chat');
            user.emit('user_message', 'A hidden account still keeps its messages');
            const updated = await hiddenUpdate;
            assert.equal(updated.summary.hidden, true);
            assert.equal(updated.summary.hiddenReason, 'manual');
            expectedHistory.push({ sender: 'user', text: 'A hidden account still keeps its messages' });
            const disk = JSON.parse(fs.readFileSync(path.join(data, 'accounts.json'), 'utf8'));
            const savedUser = disk.users.find((entry) => entry.id === 'inactive-user');
            assert.equal(savedUser.developerHidden, true);
            assert.equal(savedUser.passwordHash, seed.users[1].passwordHash);
            assert.deepEqual(disk.chats['inactive-user'].messages, expectedHistory);
            list = event(admin, 'developer_chats');
            const signedInAgain = await request('/api/login', { email: 'inactive@example.com', password: 'inactive-password' });
            assert.equal(signedInAgain.response.status, 200);
            assert.equal((await list).hidden.find((entry) => entry.userId === 'inactive-user').hiddenReason, 'manual');
            await request('/api/logout', {}, signedInAgain.body.sessionToken);
            user.disconnect(); admin.disconnect();
            await stop(); await start();
            list = event(admin, 'developer_chats');
            admin.connect();
            assert.equal((await list).hidden.find((entry) => entry.userId === 'inactive-user').hiddenReason, 'manual');
            const saved = event(admin, 'admin_chat_history');
            admin.emit('load_admin_chat', 'inactive-user');
            assert.deepEqual((await saved).messages, expectedHistory);
            const stillAccessible = event(user, 'chat_history');
            const hiddenOnlineList = event(admin, 'developer_chats');
            user.connect();
            assert.deepEqual(await stillAccessible, expectedHistory);
            await hiddenOnlineList;
            list = event(admin, 'developer_chats');
            assert.equal((await visibility(false)).success, true);
            assert.equal((await list).visible.some((entry) => entry.userId === 'inactive-user'), true);
        } finally {
            if (user) user.disconnect(); admin.disconnect();
            if (userToken) await request('/api/logout', {}, userToken);
            await request('/api/logout', {}, adminLogin.body.sessionToken);
        }
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
