/** All configuration comes from environment variables (and .env, if present). */
try {
  process.loadEnvFile(); // native Node .env support; real env vars still win
} catch {
  // no .env file — that's fine
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  /** Pino log level: trace, debug, info, warn, error, fatal. */
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /** Header set by the forward-auth proxy containing the username. */
  userHeader: (process.env.USER_HEADER ?? 'remote-user').toLowerCase(),

  /**
   * Group-based access control, following oauth2-proxy's forward-auth
   * convention: the proxy sends the user's groups in a comma-separated
   * header (X-Forwarded-Groups). If AUTHORIZED_GROUPS is empty, any
   * authenticated user is allowed.
   */
  userGroupHeader: (process.env.USER_GROUP_HEADER ?? 'x-forwarded-groups').toLowerCase(),
  authorizedGroups: (process.env.AUTHORIZED_GROUPS ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean),

  /**
   * IPs/CIDRs allowed to talk to this service (i.e. the forward-auth
   * proxies whose headers we trust), e.g. "10.0.0.5, 192.168.0.0/16".
   * Empty = accept connections from anywhere (headers taken on faith).
   */
  allowedProxies: (process.env.ALLOWED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),

  /** Create-a-Container manager. */
  managerUrl: (process.env.MANAGER_URL ?? 'https://manager.os.mieweb.org').replace(/\/+$/, ''),
  managerApiKey: process.env.MANAGER_API_KEY ?? '',
  siteId: process.env.SITE_ID ?? '1',

  /** Container settings. */
  template: process.env.TEMPLATE ?? 'ozwell-studio',
  /** Set to '' to register containers under the bare hash. */
  hostnamePrefix: process.env.HOSTNAME_PREFIX ?? 'ozwell-studio',
  hashLength: Number(process.env.HASH_LENGTH ?? 12),

  /**
   * External domain the container's HTTP services are published under:
   *   https://{hostname}.{EXTERNAL_DOMAIN}         -> APP_PORT
   *   https://{hostname}-studio.{EXTERNAL_DOMAIN}  -> STUDIO_PORT
   * Users are redirected to the -studio one. Must match an external domain
   * configured in the manager.
   */
  externalDomain: process.env.EXTERNAL_DOMAIN ?? 'os.mieweb.org',
  externalScheme: process.env.EXTERNAL_SCHEME ?? 'https',

  /**
   * Path users land on within the studio service. The ozwell-studio
   * template serves the UI at /studio/ and only redirects `/` there for
   * document requests, so link straight to it instead of relying on that.
   */
  studioPath: process.env.STUDIO_PATH ?? '/studio/',
  appPort: Number(process.env.APP_PORT ?? 3000),
  studioPort: Number(process.env.STUDIO_PORT ?? 6080),

  /** Job polling. */
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 3000),
  provisionTimeoutMs: Number(process.env.PROVISION_TIMEOUT_MS ?? 600_000),
};
