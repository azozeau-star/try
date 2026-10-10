const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const fs = require('fs');
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
const DATA_DIRECTORY = process.env.DATA_DIRECTORY
    ? path.resolve(process.env.DATA_DIRECTORY)
    : path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIRECTORY, 'accounts.json');
fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
let database = { users: [], chats: {}, sessions: [] };
if (fs.existsSync(DATA_FILE)) {
    database = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(database.users) || !database.chats || typeof database.chats !== 'object') {
        throw new Error('The account database has an invalid format.');
    }
    if (!Array.isArray(database.sessions)) database.sessions = [];
} else if (process.env.INITIAL_DATA_JSON) {
    // Private deployment seed only: never publish account records in the repository.
    let snapshot;
    try {
        snapshot = JSON.parse(process.env.INITIAL_DATA_JSON);
    } catch {
        throw new Error('INITIAL_DATA_JSON is not valid JSON.');
    }
    if (!snapshot || !Array.isArray(snapshot.users) || !snapshot.chats ||
        typeof snapshot.chats !== 'object' || Array.isArray(snapshot.chats) ||
        snapshot.users.some((user) => !user ||
            ['id', 'name', 'email', 'salt', 'passwordHash'].some((key) => typeof user[key] !== 'string')) ||
        Object.values(snapshot.chats).some((chat) => !chat || !Array.isArray(chat.messages))) {
        throw new Error('INITIAL_DATA_JSON has an invalid account database format.');
    }
    // Restore password hashes and history, but require fresh sign-ins.
    database = { users: snapshot.users, chats: snapshot.chats, sessions: [] };
    persistDatabase();
    const messageCount = Object.values(database.chats).reduce((count, chat) => count + chat.messages.length, 0);
    console.log(`Restored ${database.users.length} accounts and ${messageCount} messages from private initialization data.`);
}

function persistDatabase() {
    const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(database), { mode: 0o600 });
    fs.renameSync(tempFile, DATA_FILE);
}

const activeChats = {};
function sessionFromToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const index = database.sessions.findIndex((session) => session.tokenHash === tokenHash);
    if (index < 0) return null;
    if (database.sessions[index].expiresAt <= Date.now()) {
        database.sessions.splice(index, 1);
        persistDatabase();
        return null;
    }
    return { ...database.sessions[index], tokenHash };
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

function createSession(res, session) {
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    database.sessions = database.sessions.filter((entry) => entry.expiresAt > Date.now());
    database.sessions.push({ ...session, tokenHash, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    persistDatabase();
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

app.get('/api/me', (req, res) => {
    const session = sessionFromHeaders(req.headers);
    if (!session) return res.json({ authenticated: false });
    if (session.role === 'admin') return res.json({ authenticated: true, role: 'admin' });
    const user = database.users.find((entry) => entry.id === session.userId);
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
        if (database.users.some((user) => user.email === email)) {
            return res.status(409).json({ error: 'يوجد حساب بهذا البريد الإلكتروني. سجّل الدخول بدلاً من ذلك.' });
        }

        const { salt, hash } = await hashPassword(password);
        if (database.users.some((user) => user.email === email)) {
            return res.status(409).json({ error: 'يوجد حساب بهذا البريد الإلكتروني. سجّل الدخول بدلاً من ذلك.' });
        }
        const user = { id: randomBytes(16).toString('hex'), name, email, salt, passwordHash: hash };
        database.users.push(user);
        database.chats[user.id] = { displayName: name, messages: [] };
        persistDatabase();
        createSession(res, { role: 'user', userId: user.id });
        return res.status(201).json({ authenticated: true, role: 'user', user: publicUser(user), sessionToken: res.locals.sessionToken });
    } catch (error) {
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
        const user = database.users.find((entry) => entry.email === email);
        if (!user || password.length > 128 || !await verifyPassword(password, user)) {
            recordFailedLogin(attemptKey);
            return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
        }
        failedLoginAttempts.delete(attemptKey);
        createSession(res, { role: 'user', userId: user.id });
        return res.json({ authenticated: true, role: 'user', user: publicUser(user), sessionToken: res.locals.sessionToken });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/admin/login', (req, res) => {
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
    createSession(res, { role: 'admin' });
    return res.json({ authenticated: true, role: 'admin', sessionToken: res.locals.sessionToken });
});

app.post('/api/logout', (req, res) => {
    const session = sessionFromHeaders(req.headers);
    if (session) {
        database.sessions = database.sessions.filter((entry) => entry.tokenHash !== session.tokenHash);
        persistDatabase();
        for (const connectedSocket of io.sockets.sockets.values()) {
            if (connectedSocket.sessionTokenHash === session.tokenHash) connectedSocket.disconnect(true);
        }
    }
    setSessionCookie(res, '', 0);
    return res.json({ success: true });
});

io.use((socket, next) => {
    const session = (socket.handshake.auth && socket.handshake.auth.token
        ? sessionFromToken(socket.handshake.auth.token)
        : sessionFromHeaders(socket.handshake.headers));
    if (!session) return next(new Error('Authentication required'));
    socket.sessionTokenHash = session.tokenHash;
    if (session.role === 'admin') {
        socket.role = 'admin';
        return next();
    }
    const user = database.users.find((entry) => entry.id === session.userId);
    if (!user) return next(new Error('Authentication required'));
    socket.role = 'user';
    socket.accountId = user.id;
    socket.accountName = user.name;
    return next();
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

function adminChat(targetId) {
    if (typeof targetId !== 'string') return null;
    const connected = Object.hasOwn(activeChats, targetId) ? activeChats[targetId] : null;
    const accountId = connected ? connected.accountId : targetId;
    if (!Object.hasOwn(database.chats, accountId)) return null;
    return {
        accountId,
        saved: database.chats[accountId],
        connections: Object.entries(activeChats).filter(([, chat]) => chat.accountId === accountId)
    };
}

function savedChatList() {
    return Object.entries(database.chats).map(([accountId, saved]) => {
        const chat = adminChat(accountId);
        return {
            userId: accountId,
            displayName: saved.displayName,
            online: chat.connections.length > 0,
            messageCount: saved.messages.length,
            humanTakeover: chat.connections.some(([, connected]) => connected.humanTakeover)
        };
    });
}

function broadcastChatList() {
    // Only authenticated developer sockets join this room.
    io.to('admins').emit('saved_chats', savedChatList());
}

io.on('connection', (socket) => {
    if (socket.role === 'admin') {
        socket.join('admins');
        socket.emit('active_users', Object.entries(activeChats).map(([userId, chat]) => ({
            userId,
            displayName: chat.displayName
        })));
        socket.emit('saved_chats', savedChatList());

        socket.on('load_admin_chat', (userId) => {
            const chat = adminChat(userId);
            if (chat) {
                const humanTakeover = chat.connections.some(([, connected]) => connected.humanTakeover);
                socket.emit('admin_chat_history', {
                    userId, accountId: chat.accountId, displayName: chat.saved.displayName,
                    messages: chat.saved.messages, online: chat.connections.length > 0, humanTakeover
                });
                socket.emit('admin_takeover_state', { userId, accountId: chat.accountId, humanTakeover });
            }
        });

        socket.on('admin_set_takeover', (data) => {
            if (!data || typeof data.userId !== 'string' || typeof data.enabled !== 'boolean') return;
            const chat = adminChat(data.userId);
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

        socket.on('admin_message', (data) => {
            if (!data || typeof data.userId !== 'string' || typeof data.text !== 'string') return;
            const chat = adminChat(data.userId);
            if (!chat || !chat.connections.length || !data.text.trim()) return;
            const message = { sender: 'Developer', text: data.text.trim().slice(0, 4000) };
            chat.saved.messages.push(message);
            persistDatabase();
            for (const [connectionId] of chat.connections) io.to(connectionId).emit('receive_message', message);
            io.to('admins').emit('update_admin_chat', {
                userId: data.userId,
                accountId: chat.accountId,
                displayName: chat.saved.displayName,
                messages: chat.saved.messages
            });
        });
        return;
    }

    const savedChat = database.chats[socket.accountId] || { displayName: socket.accountName, messages: [] };
    savedChat.displayName = socket.accountName;
    database.chats[socket.accountId] = savedChat;
    activeChats[socket.id] = {
        accountId: socket.accountId,
        displayName: socket.accountName,
        messages: savedChat.messages,
        humanTakeover: Object.values(activeChats).some((chat) => chat.accountId === socket.accountId && chat.humanTakeover)
    };
    persistDatabase();
    socket.emit('chat_history', savedChat.messages);
    socket.emit('takeover_state', activeChats[socket.id].humanTakeover);
    io.to('admins').emit('new_user', { userId: socket.id, displayName: socket.accountName });
    broadcastChatList();

    socket.on('user_message', async (text) => {
        const userId = socket.id;
        const chat = activeChats[userId];
        if (!chat || typeof text !== 'string' || !text.trim()) return;

        const message = { sender: 'user', text: text.trim().slice(0, 4000) };
        chat.messages.push(message);
        persistDatabase();
        io.to('admins').emit('update_admin_chat', { userId, accountId: chat.accountId, displayName: chat.displayName, messages: chat.messages });

        if (!chat.humanTakeover) {
            const aiReply = await getMedicalAIResponse(message.text);
            const reply = { sender: 'AI', text: aiReply };
            chat.messages.push(reply);
            persistDatabase();

            socket.emit('receive_message', reply);
            io.to('admins').emit('update_admin_chat', { userId, accountId: chat.accountId, displayName: chat.displayName, messages: chat.messages });
        }
    });

    socket.on('disconnect', () => {
        if (activeChats[socket.id]) {
            io.to('admins').emit('user_disconnected', socket.id);
            delete activeChats[socket.id];
            broadcastChatList();
        }
    });
});

app.use(express.static(path.join(__dirname, 'docs')));

app.get('/api/health', (req, res) => {
    res.json({ service: 'sami-says', status: 'ok', adminConfigured: Boolean(ADMIN_PASSWORD), aiConfigured: Boolean(groq) });
});

app.use((error, req, res, next) => {
    console.error('Request Error:', error);
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return res.status(status).json({
        error: status === 400 ? 'الطلب غير صالح.' : 'حدث خطأ داخلي. حاول مرة أخرى.'
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
