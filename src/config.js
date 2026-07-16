/**
 * All configuration comes from environment variables (and .env, if
 * present). Every variable is documented in the README's Configuration
 * table (the canonical reference) and in .env.example.
 */
try {
  process.loadEnvFile(); // native Node .env support; real env vars still win
} catch {
  // no .env file — that's fine
}

/** Numeric env var: the default when unset, an error when not a number. */
function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number (got "${raw}")`);
  }
  return value;
}

/** Comma-separated env var as a trimmed list. */
function csv(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  port: num('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /** Forward-auth: identity headers and who we trust to send them. */
  userHeader: (process.env.USER_HEADER ?? 'remote-user').toLowerCase(),
  userGroupHeader: (process.env.USER_GROUP_HEADER ?? 'x-forwarded-groups').toLowerCase(),
  authorizedGroups: csv('AUTHORIZED_GROUPS'), // empty = any authenticated user
  allowedProxies: csv('ALLOWED_PROXIES'), // IPs/CIDRs; empty = trust anywhere

  /** Create-a-Container manager. */
  managerUrl: (process.env.MANAGER_URL ?? 'https://manager.os.mieweb.org').replace(/\/+$/, ''),
  managerApiKey: process.env.MANAGER_API_KEY ?? '',
  siteId: process.env.SITE_ID ?? '1',

  /** Container settings. */
  template: process.env.TEMPLATE ?? 'ozwell-studio',
  hostnamePrefix: process.env.HOSTNAME_PREFIX ?? 'ozwell-studio', // '' = bare random id

  /** Where the container's HTTP services are published. */
  externalDomain: process.env.EXTERNAL_DOMAIN ?? 'os.mieweb.org',
  externalScheme: process.env.EXTERNAL_SCHEME ?? 'https',
  studioPath: process.env.STUDIO_PATH ?? '/studio/',
  appPort: num('APP_PORT', 3000),
  studioPort: num('STUDIO_PORT', 6080),

  /** Job polling. */
  pollIntervalMs: num('POLL_INTERVAL_MS', 3000),
  provisionTimeoutMs: num('PROVISION_TIMEOUT_MS', 600_000),
};
