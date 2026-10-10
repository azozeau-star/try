const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { createPostgresStorage, migrateDatabase } = require('../storage');

test('PostgreSQL migration and durable account/chat operations', async (t) => {
    // PGlite runs the real PostgreSQL engine locally, without live credentials.
    const db = new PGlite();
    t.after(() => db.close());
    const query = async (sql, params) => {
        if (!params && sql.includes('CREATE TABLE')) return db.exec(sql);
        const result = await db.query(sql, params);
        return { ...result, rowCount: result.affectedRows };
    };
    const pool = { query, on() {}, async connect() { return { query, release() {} }; }, async end() {} };
    const user = { id: 'existing', name: 'Existing account', email: 'existing@example.com', salt: 'original-salt',
        passwordHash: 'original-password-hash', lastLoginAt: Date.now() - 1000, developerHidden: true };
    const seed = { users: [user], chats: { existing: { displayName: user.name,
        messages: [{ sender: 'user', text: 'Original question' }] } },
        sessions: [{ tokenHash: 'old-imported-token', expiresAt: Date.now() + 100000 }] };
    await migrateDatabase('', seed, pool);
    const first = createPostgresStorage('', pool);
    await first.initialize();
    assert.deepEqual(await first.findUser(user.email), user);
    assert.equal(await first.getSession('old-imported-token'), undefined);

    const second = createPostgresStorage('', pool);
    const replies = [{ sender: 'Developer', text: 'Offline answer one' }, { sender: 'Developer', text: 'Offline answer two' }];
    await Promise.all([first.appendMessage(user.id, replies[0]), second.appendMessage(user.id, replies[1])]);
    const saved = await second.getChat(user.id);
    assert.equal(saved.messages.length, 3);
    assert.deepEqual(new Set(saved.messages.slice(1).map((message) => message.text)), new Set(replies.map((message) => message.text)));
    // Re-running an old import must not overwrite new messages or visibility.
    await migrateDatabase('', { ...seed, users: [{ ...user, developerHidden: false }] }, pool);
    assert.deepEqual(await second.getChat(user.id), saved);
    assert.equal((await second.getUser(user.id)).developerHidden, true);
    await first.setUserFields(user.id, { lastLoginAt: Date.now() });
    await second.setUserFields(user.id, { developerHidden: false });
    assert.equal((await first.getUser(user.id)).passwordHash, user.passwordHash);
    assert.equal((await first.getUser(user.id)).developerHidden, false);

    const session = { role: 'user', userId: user.id, tokenHash: 'new-session', expiresAt: Date.now() + 100000 };
    await first.addSession(session);
    assert.deepEqual(await second.getSession(session.tokenHash), session);
    await second.removeSession(session.tokenHash);
    assert.equal(await first.getSession(session.tokenHash), undefined);
    await first.addSession({ ...session, tokenHash: 'expired-session', expiresAt: Date.now() - 1 });
    assert.equal(await first.getSession('expired-session'), undefined);

    await assert.rejects(first.createAccount({ ...user, id: 'duplicate-email' }), { code: '23505' });
    assert.equal(await second.getUser('duplicate-email'), undefined);
    const newUser = { ...user, id: 'new-user', email: 'new@example.com' };
    await first.createAccount(newUser);
    assert.deepEqual(await second.getChat(newUser.id), { displayName: newUser.name, messages: [] });
    const summaries = await second.summaries();
    assert.equal(summaries.find((row) => row.user.id === user.id).messageCount, 3);
    assert.equal(summaries[0].user.passwordHash, undefined);
    assert.equal(summaries[0].messages, undefined);

    const failure = createPostgresStorage('', { ...pool, async query() { throw new Error('Disconnected'); } });
    await assert.rejects(failure.appendMessage(user.id, { sender: 'Developer', text: 'Must not save' }));
    assert.deepEqual(await first.getChat(user.id), saved);
});
