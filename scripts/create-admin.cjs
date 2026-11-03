const crypto = require('node:crypto');
const { Pool } = require('pg');
const normalizeConnectionString = require('./connection-string.cjs');

const connectionString = normalizeConnectionString(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL);
const email = String(process.env.VARSITYONE_ADMIN_EMAIL || process.env.UEMP_ADMIN_EMAIL || '').trim().toLowerCase();
const name = String(process.env.VARSITYONE_ADMIN_NAME || process.env.UEMP_ADMIN_NAME || '').trim();
const password = process.env.VARSITYONE_ADMIN_PASSWORD || process.env.UEMP_ADMIN_PASSWORD || '';

if (!connectionString) throw new Error('Set DATABASE_URL to the Neon PostgreSQL connection string.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set VARSITYONE_ADMIN_EMAIL to a valid email address.');
if (name.length < 2 || name.length > 100) throw new Error('Set VARSITYONE_ADMIN_NAME to a name between 2 and 100 characters.');
if (password.length < 16 || password.length > 256) throw new Error('Set VARSITYONE_ADMIN_PASSWORD to a password between 16 and 256 characters.');

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 10_000,
  application_name: 'varsityone-initial-admin',
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71024012]);
    const existing = await client.query("SELECT id FROM users WHERE role='super_admin' LIMIT 1");
    if (existing.rowCount) throw new Error('An active super administrator already exists; bootstrap was refused.');

    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
    const passwordHash = `${salt}:${Buffer.from(derived).toString('hex')}`;
    const user = (await client.query(
      "INSERT INTO users(email,password_hash,role,name) VALUES ($1,$2,'super_admin',$3) RETURNING id",
      [email, passwordHash, name],
    )).rows[0];
    await client.query(
      "INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details) VALUES (NULL,'admin.bootstrap','user',$1,$2::jsonb)",
      [user.id, JSON.stringify({ email })],
    );
    await client.query('COMMIT');
    console.log(`Initial super administrator created for ${email}. Sign in at the VarsityONE deployment.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`Initial administrator setup failed: ${error.message}`);
  process.exitCode = 1;
});
