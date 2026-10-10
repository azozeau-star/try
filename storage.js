const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function validateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.users) || !snapshot.chats ||
        typeof snapshot.chats !== 'object' || Array.isArray(snapshot.chats) ||
        snapshot.users.some((user) => !user ||
            ['id', 'name', 'email', 'salt', 'passwordHash'].some((key) => typeof user[key] !== 'string')) ||
        Object.values(snapshot.chats).some((chat) => !chat || !Array.isArray(chat.messages))) {
        throw new Error('The account database has an invalid format.');
    }
    return snapshot;
}

function trackingStart() {
    const configured = Number(process.env.LOGIN_TRACKING_STARTED_AT);
    return Number.isFinite(configured) && configured > 0 ? configured : Date.now();
}

function prepareSeed(snapshot) {
    validateSnapshot(snapshot);
    return { users: snapshot.users.map((user) => ({ ...user,
        lastLoginAt: Number.isFinite(user.lastLoginAt) && user.lastLoginAt > 0 ? user.lastLoginAt : trackingStart() })),
        chats: snapshot.chats, sessions: [] };
}

function createFileStorage(directory, initialData) {
    const filename = path.join(directory, 'accounts.json');
    fs.mkdirSync(directory, { recursive: true });
    const existing = fs.existsSync(filename);
    let data = existing ? validateSnapshot(JSON.parse(fs.readFileSync(filename, 'utf8')))
        : initialData ? prepareSeed(JSON.parse(initialData)) : { users: [], chats: {}, sessions: [] };
    if (!Array.isArray(data.sessions)) data.sessions = [];
    for (const user of data.users) {
        if (!Number.isFinite(user.lastLoginAt) || user.lastLoginAt <= 0) user.lastLoginAt = trackingStart();
        data.chats[user.id] ||= { displayName: user.name, messages: [] };
    }
    const copy = (value) => value == null ? value : structuredClone(value);
    function persist() {
        const temp = `${filename}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(temp, filename);
    }
    function mutate(action) {
        const previous = copy(data);
        try { const result = action(); persist(); return copy(result); }
        catch (error) { data = previous; throw error; }
    }
    persist();
    return {
        kind: 'file',
        async getUser(id) { return copy(data.users.find((user) => user.id === id)); },
        async findUser(email) { return copy(data.users.find((user) => user.email === email)); },
        async createAccount(user) {
            return mutate(() => {
                if (data.users.some((entry) => entry.email === user.email)) {
                    const error = new Error('Duplicate email'); error.code = '23505'; throw error;
                }
                data.users.push(copy(user)); data.chats[user.id] = { displayName: user.name, messages: [] };
                return user;
            });
        },
        async setUserFields(id, fields) {
            return mutate(() => {
                const user = data.users.find((entry) => entry.id === id);
                if (!user) return null;
                Object.assign(user, fields); return user;
            });
        },
        async getChat(id) { return copy(data.chats[id]); },
        async summaries() {
            return data.users.map((user) => ({ user: copy(user), displayName: data.chats[user.id].displayName,
                messageCount: data.chats[user.id].messages.length }));
        },
        async appendMessage(id, message) {
            return mutate(() => { data.chats[id].messages.push(copy(message)); return data.chats[id]; });
        },
        async getSession(hash) { return copy(data.sessions.find((entry) => entry.tokenHash === hash && entry.expiresAt > Date.now())); },
        async addSession(session) {
            mutate(() => { data.sessions = data.sessions.filter((entry) => entry.expiresAt > Date.now()); data.sessions.push(copy(session)); });
        },
        async removeSession(hash) { mutate(() => { data.sessions = data.sessions.filter((entry) => entry.tokenHash !== hash); }); },
        async health() { return true; },
        async close() {}
    };
}

function createPostgresStorage(connectionString, pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 })) {
    pool.on('error', () => console.error('Database connection interrupted. New requests will reconnect.'));
    return {
        kind: 'postgres',
        async initialize() { await pool.query('SELECT id FROM sami_users LIMIT 1'); },
        async getUser(id) { return (await pool.query('SELECT profile FROM sami_users WHERE id = $1', [id])).rows[0]?.profile; },
        async findUser(email) { return (await pool.query('SELECT profile FROM sami_users WHERE email = $1', [email])).rows[0]?.profile; },
        async createAccount(user) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO sami_users (id, email, profile) VALUES ($1, $2, $3::jsonb)', [user.id, user.email, JSON.stringify(user)]);
                await client.query('INSERT INTO sami_chats (user_id, display_name) VALUES ($1, $2)', [user.id, user.name]);
                await client.query('COMMIT');
                return user;
            } catch (error) { await client.query('ROLLBACK'); throw error; }
            finally { client.release(); }
        },
        async setUserFields(id, fields) {
            return (await pool.query('UPDATE sami_users SET profile = profile || $2::jsonb WHERE id = $1 RETURNING profile',
                [id, JSON.stringify(fields)])).rows[0]?.profile;
        },
        async getChat(id) {
            const row = (await pool.query('SELECT display_name, messages FROM sami_chats WHERE user_id = $1', [id])).rows[0];
            return row ? { displayName: row.display_name, messages: row.messages } : null;
        },
        async summaries() {
            // Lists never fetch password hashes or entire conversations.
            return (await pool.query(`SELECT jsonb_build_object('id', u.id, 'name', u.profile->>'name',
                'lastLoginAt', u.profile->'lastLoginAt', 'developerHidden', u.profile->'developerHidden') AS "user",
                c.display_name AS "displayName", jsonb_array_length(c.messages) AS "messageCount"
                FROM sami_users u JOIN sami_chats c ON c.user_id = u.id ORDER BY u.id`)).rows;
        },
        async appendMessage(id, message) {
            // PostgreSQL locks this row and appends atomically, including concurrent replies.
            const row = (await pool.query(`UPDATE sami_chats SET messages = messages || $2::jsonb
                WHERE user_id = $1 RETURNING display_name, messages`, [id, JSON.stringify([message])])).rows[0];
            if (!row) throw new Error('Conversation not found');
            return { displayName: row.display_name, messages: row.messages };
        },
        async getSession(hash) {
            return (await pool.query('SELECT session FROM sami_sessions WHERE token_hash = $1 AND expires_at > $2',
                [hash, Date.now()])).rows[0]?.session;
        },
        async addSession(session) {
            await pool.query('INSERT INTO sami_sessions (token_hash, expires_at, session) VALUES ($1, $2, $3::jsonb)',
                [session.tokenHash, session.expiresAt, JSON.stringify(session)]);
            await pool.query('DELETE FROM sami_sessions WHERE expires_at <= $1', [Date.now()]);
        },
        async removeSession(hash) { await pool.query('DELETE FROM sami_sessions WHERE token_hash = $1', [hash]); },
        async health() { await pool.query('SELECT 1'); return true; },
        async close() { await pool.end(); }
    };
}

async function migrateDatabase(connectionString, snapshot, pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15000 })) {
    if (snapshot) snapshot = prepareSeed(snapshot);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(__dirname, 'migrations/001-storage.sql'), 'utf8'));
        if (snapshot) {
            for (const user of snapshot.users) {
                const inserted = await client.query(`INSERT INTO sami_users (id, email, profile) VALUES ($1, $2, $3::jsonb)
                    ON CONFLICT (id) DO NOTHING RETURNING id`, [user.id, user.email, JSON.stringify(user)]);
                if (inserted.rowCount) {
                    const chat = snapshot.chats[user.id] || { displayName: user.name, messages: [] };
                    await client.query('INSERT INTO sami_chats (user_id, display_name, messages) VALUES ($1, $2, $3::jsonb)',
                        [user.id, chat.displayName, JSON.stringify(chat.messages)]);
                }
            }
        }
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); await pool.end(); }
}

async function createStorage() {
    if (process.env.DATABASE_URL) {
        const storage = createPostgresStorage(process.env.DATABASE_URL);
        await storage.initialize(); // Fail startup instead of silently using temporary files.
        return storage;
    }
    return createFileStorage(process.env.DATA_DIRECTORY ? path.resolve(process.env.DATA_DIRECTORY) : path.join(__dirname, '.data'),
        process.env.INITIAL_DATA_JSON);
}

module.exports = { createStorage, createPostgresStorage, migrateDatabase };
