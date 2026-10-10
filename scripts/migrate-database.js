const fs = require('node:fs');
require('dotenv').config();
const { migrateDatabase } = require('../storage');

async function main() {
    const connection = process.env.DATABASE_URL_UNPOOLED;
    if (!connection) throw new Error('Set DATABASE_URL_UNPOOLED privately before running migrations.');
    const snapshot = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : undefined;
    await migrateDatabase(connection, snapshot);
    console.log('Database schema ready. Existing accounts and messages were preserved.');
}
main().catch(() => { console.error('Database migration failed. Check the private connection and backup file.'); process.exitCode = 1; });
