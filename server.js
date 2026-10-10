const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const { createStorage } = require('./storage');
const path = require('path');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
require('dotenv').config();

// --- CONFIGURATION ---
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// Comma-separated frontend origins, plus this server's own origin.
const FRONTEND_ORIGINS = (process.env.STATIC_SITE_ORIGIN || '').split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
const GROQ_MODEL = process.env.GROQ_MODEL || 'allam-2-7b';
const groq = GROQ_API_KEY
    ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
    : null;
const scryptAsync = promisify(scrypt);
// ---------------------

async function main() {
const storage = await createStorage();
const app = express();
// Render terminates HTTPS at its reverse proxy.
app.set('trust proxy', 1);
function originIsAllowed(req, origin) {
    if (!origin) return true; // Non-browser clients still need authentication.
    return origin === `${req.protocol}://${req.get('host')}` || FRONTEND_ORIGINS.includes(origin);
}
app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (!originIsAllowed(req, origin)) {
        return res.status(403).json({ error: 'هذا الموقع غير مسموح له بالاتصال بالخادم.' });
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.vary('Origin');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
});
const server = http.createServer(app);
const io = new Server(server, {
    // Reflect origins for CORS; allowRequest below authorizes the handshake.
    cors: { origin: true, credentials: true },
    // Applies to WebSocket upgrades as well as polling requests.
    allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        const protocol = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? 'https' : 'http';
        callback(null, !origin || origin === `${protocol}://${req.headers.host}` || FRONTEND_ORIGINS.includes(origin));
    }
});
const INACTIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function hiddenReason(user, now = Date.now()) {
    if (user.developerHidden === true) return 'manual';
    return now - user.lastLoginAt >= INACTIVE_AFTER_MS ? 'inactive' : null;
}

const activeChats = {};
async function sessionFromToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return await storage.getSession(tokenHash) || null;
}
function sessionFromHeaders(headers = {}) {
    if (headers.authorization) {
        return sessionFromToken(headers.authorization.startsWith('Bearer ') ? headers.authorization.slice(7) : '');
    }
    const cookie = (headers.cookie || '').split(';').map((item) => item.trim())
        .find((item) => item.startsWith('sami_session='));
    return sessionFromToken(cookie ? cookie.slice('sami_session='.length) : '');
}
function setSessionCookie(res, token, maxAge = 604800) {
    const secure = res.req.secure ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `sami_session=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

async function createSession(res, session) {
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await storage.addSession({ ...session, tokenHash, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    const origin = res.req.get('Origin');
    if (origin && origin !== `${res.req.protocol}://${res.req.get('host')}`) {
        // Static hosting uses a bearer session instead of third-party cookies.
        res.locals.sessionToken = token;
    } else {
        setSessionCookie(res, token);
    }
}

function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email };
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const derivedKey = await scryptAsync(password, salt, 64);
    return { salt, hash: derivedKey.toString('hex') };
}

async function verifyPassword(password, user) {
    const { hash } = await hashPassword(password, user.salt);
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const failedLoginAttempts = new Map();
function loginIsRateLimited(key) {
    const now = Date.now();
    for (const [attemptKey, attempt] of failedLoginAttempts) {
        if (attempt.startedAt <= now - 15 * 60 * 1000) failedLoginAttempts.delete(attemptKey);
    }
    const attempt = failedLoginAttempts.get(key);
    return Boolean(attempt && attempt.count >= 5);
}

function recordFailedLogin(key) {
    const now = Date.now();
    const attempt = failedLoginAttempts.get(key);
    if (!attempt || attempt.startedAt <= now - 15 * 60 * 1000) {
        failedLoginAttempts.set(key, { count: 1, startedAt: now });
    } else {
        attempt.count += 1;
    }
}

app.use(express.json({ limit: '16kb' }));

app.get('/api/me', async (req, res) => {
    const session = await sessionFromHeaders(req.headers);
    if (!session) return res.json({ authenticated: false });
    if (session.role === 'admin') return res.json({ authenticated: true, role: 'admin' });
    const user = await storage.getUser(session.userId);
    if (!user) return res.json({ authenticated: false });
    return res.json({ authenticated: true, role: 'user', user: publicUser(user) });
});

app.post('/api/signup', async (req, res, next) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 50) : '';
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!name || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
            return res.status(400).json({ error: 'أدخل اسماً وبريداً إلكترونياً صحيحاً وكلمة مرور من 8 أحرف على الأقل.' });
        }
        if (await storage.findUser(email)) {
            return res.status(409).json({ error: 'يوجد حساب بهذا البريد الإلكتروني. سجّل الدخول بدلاً من ذلك.' });
        }

        const { salt, hash } = await hashPassword(password);
        const user = { id: randomBytes(16).toString('hex'), name, email, salt, passwordHash: hash, lastLoginAt: Date.now() };
        await storage.createAccount(user);
        await createSession(res, { role: 'user', userId: user.id });
        await broadcastChatList();
        return res.status(201).json({ authenticated: true, role: 'user', user: publicUser(user), sessionToken: res.locals.sessionToken });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'يوجد حساب بهذا البريد الإلكتروني. سجّل الدخول بدلاً من ذلك.' });
        return next(error);
    }
});

app.post('/api/login', async (req, res, next) => {
    try {
        const attemptKey = `user:${req.ip}`;
        if (loginIsRateLimited(attemptKey)) return res.status(429).json({ error: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.' });
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const user = await storage.findUser(email);
        if (!user || password.length > 128 || !await verifyPassword(password, user)) {
            recordFailedLogin(attemptKey);
            return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
        }
        failedLoginAttempts.delete(attemptKey);
        await storage.setUserFields(user.id, { lastLoginAt: Date.now() });
        await createSession(res, { role: 'user', userId: user.id });
        await broadcastChatList();
        return res.json({ authenticated: true, role: 'user', user: publicUser(user), sessionToken: res.locals.sessionToken });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/admin/login', async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'لم يتم إعداد كلمة مرور لوحة المطور. اضبط ADMIN_PASSWORD في إعدادات الخادم.' });
    }
    const attemptKey = `admin:${req.ip}`;
    if (loginIsRateLimited(attemptKey)) return res.status(429).json({ error: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const password = typeof body.password === 'string' ? Buffer.from(body.password) : Buffer.alloc(0);
    const expected = Buffer.from(ADMIN_PASSWORD);
    if (password.length !== expected.length || !timingSafeEqual(password, expected)) {
        recordFailedLogin(attemptKey);
        return res.status(401).json({ error: 'كلمة مرور لوحة المطور غير صحيحة.' });
    }
    failedLoginAttempts.delete(attemptKey);
    await createSession(res, { role: 'admin' });
    return res.json({ authenticated: true, role: 'admin', sessionToken: res.locals.sessionToken });
});

app.post('/api/logout', async (req, res) => {
    const session = await sessionFromHeaders(req.headers);
    if (session) {
        await storage.removeSession(session.tokenHash);
        for (const connectedSocket of io.sockets.sockets.values()) {
            if (connectedSocket.sessionTokenHash === session.tokenHash) connectedSocket.disconnect(true);
        }
    }
    setSessionCookie(res, '', 0);
    return res.json({ success: true });
});

io.use(async (socket, next) => {
    try {
    const session = await (socket.handshake.auth && socket.handshake.auth.token
        ? sessionFromToken(socket.handshake.auth.token)
        : sessionFromHeaders(socket.handshake.headers));
    if (!session) return next(new Error('Authentication required'));
    socket.sessionTokenHash = session.tokenHash;
    if (session.role === 'admin') {
        socket.role = 'admin';
        return next();
    }
    const user = await storage.getUser(session.userId);
    if (!user) return next(new Error('Authentication required'));
    socket.role = 'user';
    socket.accountId = user.id;
    socket.accountName = user.name;
    socket.savedChat = await storage.getChat(user.id);
    return next();
    } catch { return next(new Error('Database unavailable. Please reconnect.')); }
});

async function getMedicalAIResponse(userMessage) {
    if (!groq) {
        return "المساعد الطبي غير متصل حالياً. أضف مفتاح Groq إلى ملف .env ثم أعد تشغيل الخادم.";
    }

    try {
        const completion = await groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are a strict medical AI assistant speaking in Arabic. You must ONLY answer questions related to medicine, health, anatomy, and biology. If the user asks about anything else, reply EXACTLY with: \"عذراً، أنا مساعد طبي ويمكنني فقط الإجابة على الأسئلة المتعلقة بالصحة والطب.\""
                },
                {
                    role: "user",
                    content: userMessage
                }
            ],
            temperature: 0.2,
            max_tokens: 300
        });

        return completion.choices[0]?.message?.content?.trim() || "المساعد الطبي غير متصل حالياً. سيقوم أحد المطورين بالرد عليك قريباً.";
    } catch (error) {
        console.error("AI Error:", error);
        return "المساعد الطبي غير متصل حالياً. سيقوم أحد المطورين بالرد عليك قريباً.";
    }
}

async function adminChat(targetId) {
    if (typeof targetId !== 'string') return null;
    const connected = Object.hasOwn(activeChats, targetId) ? activeChats[targetId] : null;
    const accountId = connected ? connected.accountId : targetId;
    const saved = await storage.getChat(accountId);
    if (!saved) return null;
    return {
        accountId,
        saved,
        connections: Object.entries(activeChats).filter(([, chat]) => chat.accountId === accountId)
    };
}

function summaryFromRow(row) {
    const { user, displayName, messageCount } = row;
    const connections = Object.values(activeChats).filter((chat) => chat.accountId === user.id);
    const reason = hiddenReason(user);
    return {
        userId: user.id,
        displayName,
        online: connections.length > 0,
        messageCount,
        humanTakeover: connections.some((connected) => connected.humanTakeover),
        lastLoginAt: user.lastLoginAt,
        hidden: Boolean(reason),
        hiddenReason: reason
    };
}

async function chatSummary(accountId) {
    const [user, chat] = await Promise.all([storage.getUser(accountId), storage.getChat(accountId)]);
    return user && chat ? summaryFromRow({ user, displayName: chat.displayName, messageCount: chat.messages.length }) : null;
}

async function developerChatLists() {
    const all = (await storage.summaries()).map(summaryFromRow);
    return { visible: all.filter((chat) => !chat.hidden), hidden: all.filter((chat) => chat.hidden) };
}

async function broadcastChatList() {
    // Only authenticated developer sockets join this room.
    if (!io.sockets.adapter.rooms.get('admins')?.size) return;
    const lists = await developerChatLists();
    io.to('admins').emit('saved_chats', lists.visible);
    io.to('admins').emit('developer_chats', lists);
}

// Refresh open dashboards as the inactivity window expires, without deleting records.
setInterval(() => {
    broadcastChatList().catch(() => console.error('Could not refresh developer chat list.'));
}, 60 * 1000).unref();

io.on('connection', (socket) => {
    function onAsync(name, handler) {
        socket.on(name, (...args) => {
            Promise.resolve().then(() => handler(...args)).catch(() => {
                console.error('Chat operation failed:', name);
                const acknowledge = args[args.length - 1];
                if (typeof acknowledge === 'function') acknowledge({ success: false, error: 'تعذر حفظ التغيير. حاول مجدداً.' });
                socket.emit('chat_error', 'تعذر الاتصال بقاعدة البيانات. حاول مجدداً.');
            });
        });
    }
    async function initializeChat() {
    if (socket.role === 'admin') {
        socket.join('admins');
        socket.emit('active_users', Object.entries(activeChats).map(([userId, chat]) => ({
            userId,
            displayName: chat.displayName
        })));
        onAsync('admin_set_user_visibility', async (data, acknowledge) => {
            const reply = (value) => { if (typeof acknowledge === 'function') acknowledge(value); };
            if (!data || typeof data.userId !== 'string' || typeof data.hidden !== 'boolean') {
                return reply({ success: false, error: 'الطلب غير صالح.' });
            }
            const user = await storage.getUser(data.userId);
            if (!user) return reply({ success: false, error: 'المستخدم غير موجود.' });
            // This only changes dashboard visibility. Passwords and chats remain intact.
            let updated;
            try {
                updated = await storage.setUserFields(user.id, { developerHidden: data.hidden });
            } catch {
                return reply({ success: false, error: 'تعذّر حفظ التغيير. حاول مجدداً.' });
            }
            await broadcastChatList();
            reply({ success: true, stillInactive: hiddenReason(updated) === 'inactive' });
        });

        onAsync('load_admin_chat', async (userId) => {
            const chat = await adminChat(userId);
            if (chat) {
                const humanTakeover = chat.connections.some(([, connected]) => connected.humanTakeover);
                socket.emit('admin_chat_history', {
                    userId, accountId: chat.accountId, displayName: chat.saved.displayName,
                    messages: chat.saved.messages, online: chat.connections.length > 0, humanTakeover
                });
                socket.emit('admin_takeover_state', { userId, accountId: chat.accountId, humanTakeover });
            }
        });

        onAsync('admin_set_takeover', async (data) => {
            if (!data || typeof data.userId !== 'string' || typeof data.enabled !== 'boolean') return;
            const chat = await adminChat(data.userId);
            if (!chat || !chat.connections.length) return;
            for (const [connectionId, connected] of chat.connections) {
                connected.humanTakeover = data.enabled;
                io.to(connectionId).emit('takeover_state', data.enabled);
            }
            io.to('admins').emit('admin_takeover_state', {
                userId: data.userId,
                accountId: chat.accountId,
                humanTakeover: data.enabled
            });
        });

        onAsync('admin_message', async (data, acknowledge) => {
            const reply = (result) => { if (typeof acknowledge === 'function') acknowledge(result); };
            if (!data || typeof data.userId !== 'string' || typeof data.text !== 'string' || !data.text.trim()) {
                reply({ success: false, error: 'اختر محادثة واكتب رسالة.' });
                return;
            }
            const chat = await adminChat(data.userId);
            if (!chat) {
                reply({ success: false, error: 'المحادثة غير موجودة.' });
                return;
            }
            const message = { sender: 'Developer', text: data.text.trim().slice(0, 4000) };
            let saved;
            try {
                saved = await storage.appendMessage(chat.accountId, message);
            } catch {
                console.error('Failed to save developer reply.');
                reply({ success: false, error: 'تعذر حفظ الرد. حاول مرة أخرى.' });
                return;
            }
            reply({ success: true });
            for (const [connectionId] of chat.connections) io.to(connectionId).emit('receive_message', message);
            io.to('admins').emit('update_admin_chat', {
                userId: data.userId,
                accountId: chat.accountId,
                displayName: saved.displayName,
                messages: saved.messages,
                summary: await chatSummary(chat.accountId)
            });
        });
        const lists = await developerChatLists();
        if (!socket.connected) return;
        socket.emit('saved_chats', lists.visible);
        socket.emit('developer_chats', lists);
        return;
    }

    const savedChat = socket.savedChat;
    delete socket.savedChat;
    if (!savedChat || !socket.connected) { socket.disconnect(true); return; }
    activeChats[socket.id] = {
        accountId: socket.accountId,
        displayName: socket.accountName,
        humanTakeover: Object.values(activeChats).some((chat) => chat.accountId === socket.accountId && chat.humanTakeover)
    };
    socket.emit('chat_history', savedChat.messages);
    socket.emit('takeover_state', activeChats[socket.id].humanTakeover);
    io.to('admins').emit('new_user', { userId: socket.id, displayName: socket.accountName });
    broadcastChatList().catch(() => console.error('Could not update connected chat list.'));

    onAsync('user_message', async (text, acknowledge) => {
        const userId = socket.id;
        const chat = activeChats[userId];
        if (!chat || typeof text !== 'string' || !text.trim()) return;

        const message = { sender: 'user', text: text.trim().slice(0, 4000) };
        const saved = await storage.appendMessage(chat.accountId, message);
        if (typeof acknowledge === 'function') acknowledge({ success: true });
        io.to('admins').emit('update_admin_chat', { userId, accountId: chat.accountId, displayName: chat.displayName, messages: saved.messages, summary: await chatSummary(chat.accountId) });

        if (!chat.humanTakeover) {
            const aiReply = await getMedicalAIResponse(message.text);
            const reply = { sender: 'AI', text: aiReply };
            const updated = await storage.appendMessage(chat.accountId, reply);

            socket.emit('receive_message', reply);
            io.to('admins').emit('update_admin_chat', { userId, accountId: chat.accountId, displayName: chat.displayName, messages: updated.messages, summary: await chatSummary(chat.accountId) });
        }
    });

    }
    socket.on('disconnect', () => {
        if (activeChats[socket.id]) {
            io.to('admins').emit('user_disconnected', socket.id);
            delete activeChats[socket.id];
            broadcastChatList().catch(() => console.error('Could not update disconnected chat list.'));
        }
    });
    initializeChat().catch(() => { console.error('Could not load saved conversation.'); socket.disconnect(true); });
});

app.use(express.static(path.join(__dirname, 'docs')));

app.get('/api/health', async (req, res) => {
    try {
        await storage.health();
        res.json({ service: 'sami-says', status: 'ok', storage: storage.kind, adminConfigured: Boolean(ADMIN_PASSWORD), aiConfigured: Boolean(groq) });
    } catch { res.status(503).json({ service: 'sami-says', status: 'unavailable', storage: storage.kind }); }
});

app.use((error, req, res, next) => {
    console.error('Request failed:', error.code || 'internal');
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return res.status(status).json({
        error: status === 400 ? 'الطلب غير صالح.' : 'حدث خطأ داخلي. حاول مرة أخرى.'
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
process.once('SIGTERM', () => {
    io.close(() => { storage.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10000).unref();
});
}
main().catch(() => { console.error('Server startup failed. Check database configuration and migrations.'); process.exitCode = 1; });
