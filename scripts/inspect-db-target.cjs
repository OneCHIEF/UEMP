const url = new URL(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '');
if (!url.hostname || !url.pathname) throw new Error('No database URL is configured.');
console.log(JSON.stringify({ host: url.hostname, database: url.pathname.slice(1), sslmode: url.searchParams.get('sslmode') || 'default' }));
