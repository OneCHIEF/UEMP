module.exports = function normalizeConnectionString(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
};
