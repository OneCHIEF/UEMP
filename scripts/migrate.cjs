const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const normalizeConnectionString = require('./connection-string.cjs');

const connectionString = normalizeConnectionString(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL);
if (!connectionString) throw new Error('Set DATABASE_URL to your Neon PostgreSQL connection string before running migrations.');
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  application_name: 'varsityone-migrations',
});
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [71024011]);
    lockHeld = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map(row => [row.name, row.checksum.trim()]));
    const files = fs.readdirSync(migrationsDir).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error(`Applied migration ${name} was modified. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log('Database schema is up to date.');
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock($1)', [71024011]).catch(() => {});
    client.release();
    await pool.end();
  }
}
main().catch(error => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
