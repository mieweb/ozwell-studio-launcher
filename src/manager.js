/**
 * Client for the Create-a-Container manager API, plus the provisioning
 * state machine that creates a container and follows its create job.
 *
 * Everything is keyed on the user's stable hash. The container record in
 * the manager is named `{HOSTNAME_PREFIX}-{hash}` so it's identifiable,
 * while the public URLs stay short: `{hash}.{domain}` and
 * `{hash}-studio.{domain}`.
 *
 * API spec: https://manager.os.mieweb.org/api/v1/openapi.yaml
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { logger } from './logger.js';

const apiLog = logger.child({ module: 'manager-api' });

/** Stable per-user hash: sha256 of the normalized username, truncated. */
export function userHash(username) {
  return createHash('sha256')
    .update(username.trim().toLowerCase())
    .digest('hex')
    .slice(0, config.hashLength);
}

/** The container's hostname in the manager (not user-facing). */
function containerHostname(hash) {
  return config.hostnamePrefix ? `${config.hostnamePrefix}-${hash}` : hash;
}

/** Where users land: the studio UI, straight at its path. */
export function containerUrl(hash) {
  return `${config.externalScheme}://${hash}-studio.${config.externalDomain}${config.studioPath}`;
}

/**
 * Minimal fetch wrapper: bearer auth, JSON, unwraps the `{ data }` envelope.
 * Every request/response is logged at debug level (LOG_LEVEL=debug).
 */
async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const url = `${config.managerUrl}/api/v1${path}`;
  const requestBody = options.body ? JSON.parse(options.body) : undefined;
  apiLog.debug({ method, url, body: requestBody }, 'manager API request');

  const started = Date.now();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.managerApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  const body = await response.json().catch(() => null);
  apiLog.debug(
    { method, url, status: response.status, elapsedMs: Date.now() - started, response: body },
    'manager API response'
  );

  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Manager API ${method} ${path}: ${message}`);
  }
  return body?.data ?? body;
}

/** Look up the user's container, or null if it doesn't exist. */
export async function findContainer(hash) {
  const hostname = containerHostname(hash);
  const containers = await api(
    `/sites/${config.siteId}/containers?hostname=${encodeURIComponent(hostname)}`
  );
  if (!Array.isArray(containers)) return null;
  return containers.find((c) => c.hostname === hostname) ?? null;
}

/**
 * Resolve the configured external domain name to its manager id, using the
 * create-form bootstrap endpoint (available to non-admin API keys).
 * Cached for the process lifetime.
 */
let cachedDomainId = null;
async function externalDomainId() {
  if (cachedDomainId != null) return cachedDomainId;
  const { externalDomains } = await api(`/sites/${config.siteId}/containers/new`);
  const domain = externalDomains?.find((d) => d.name === config.externalDomain);
  if (!domain) {
    throw new Error(
      `External domain "${config.externalDomain}" is not configured on site ${config.siteId}`
    );
  }
  cachedDomainId = domain.id;
  return cachedDomainId;
}

/**
 * Create the container with the traditional pair of HTTP services:
 *   {hash}.{domain}         -> APP_PORT    (the app itself)
 *   {hash}-studio.{domain}  -> STUDIO_PORT (the studio UI)
 */
async function createContainer(hash) {
  const domainId = await externalDomainId();
  return api(`/sites/${config.siteId}/containers`, {
    method: 'POST',
    body: JSON.stringify({
      hostname: containerHostname(hash),
      template: config.template,
      services: [
        {
          type: 'http',
          internalPort: config.appPort,
          externalHostname: hash,
          externalDomainId: domainId,
        },
        {
          type: 'http',
          internalPort: config.studioPort,
          externalHostname: `${hash}-studio`,
          externalDomainId: domainId,
          // The load balancer fronts the studio with the auth proxy, so an
          // unauthenticated probe of a healthy service gets a 302 to auth.
          authRequired: true,
        },
      ],
    }),
  });
}

async function deleteContainer(id) {
  return api(`/sites/${config.siteId}/containers/${id}`, { method: 'DELETE' });
}

/**
 * Job statuses. The runner writes 'success'/'failure'/'cancelled'
 * (the OpenAPI spec's 'completed'/'failed' is outdated — see the jobs
 * table enum in mieweb/opensource-server). Anything that is neither
 * in-progress nor success is treated as failure, like the manager's
 * own SSE stream does.
 */
const JOB_IN_PROGRESS = new Set(['pending', 'running']);
const JOB_SUCCESS = new Set(['success', 'completed']);

async function waitForJob(jobId, deadline) {
  while (Date.now() < deadline) {
    const { status } = await api(`/jobs/${jobId}`);
    if (JOB_SUCCESS.has(status)) return;
    if (!JOB_IN_PROGRESS.has(status)) {
      throw new Error(`Container creation job ended with status "${status}".`);
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error('Timed out waiting for the container to be created.');
}

/** Fallback when the manager doesn't tell us the job id. */
async function waitForContainerStatus(hash, deadline) {
  while (Date.now() < deadline) {
    const container = await findContainer(hash);
    if (container && container.status !== 'creating') {
      if (container.status === 'failed') throw new Error('Container creation failed.');
      return;
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error('Timed out waiting for the container to be created.');
}

/**
 * The create job finishing does not mean the page is reachable: the load
 * balancer control plane can lag up to a minute. Probe the studio URL
 * (without following redirects) until it responds:
 *   302          -> up (redirect to the auth page, since authRequired is set)
 *   404          -> control plane hasn't published the route yet; keep waiting
 *   502/503      -> route is up but the backend errored; redirect anyway and
 *                   let the load balancer's error page explain
 *   no response  -> DNS/connect failure; keep waiting
 * Anything else (200, 401, ...) also counts as reachable.
 */
async function waitForReachable(hash, deadline, log) {
  const url = containerUrl(hash);
  while (Date.now() < deadline) {
    let status = null;
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        // Emulate the browser navigation this probe stands in for.
        headers: { 'Sec-Fetch-Dest': 'document' },
        signal: AbortSignal.timeout(5000),
      });
      status = response.status;
    } catch {
      // not reachable yet
    }
    apiLog.debug({ url, status }, 'reachability probe');

    if (status === null || status === 404) {
      await sleep(config.pollIntervalMs);
      continue;
    }
    if (status === 502 || status === 503) {
      log.warn(`${url} responded ${status}; redirecting anyway so the load balancer can explain`);
    }
    return;
  }
  throw new Error('Timed out waiting for the workspace to become reachable.');
}

/**
 * Provisioning state, keyed by user hash.
 * Each entry is { state: 'creating' | 'ready' | 'error', url?, message? }.
 */
const provisions = new Map();

/** Emits `status(hash, entry)` whenever a provision changes state. */
export const provisionEvents = new EventEmitter().setMaxListeners(0);

/** Current provisioning entry for a user hash, or undefined. */
export function provisionStatus(hash) {
  return provisions.get(hash);
}

/**
 * Idempotently make sure the user's container exists and return the current
 * provisioning entry. Concurrent callers share one in-flight job.
 *
 * The map is only a cache of work in progress, never of the outcome:
 * 'creating' entries are shared, 'error' entries linger briefly as a
 * back-off, but a 'ready' entry is re-verified against the manager —
 * the container may have been deleted out-of-band since.
 */
export function ensureProvision(hash, log = console) {
  const existing = provisions.get(hash);
  if (existing && existing.state !== 'ready') return existing;

  const entry = { state: 'creating' };
  provisions.set(hash, entry);

  provision(hash, log)
    .then(() => {
      entry.state = 'ready';
      entry.url = containerUrl(hash);
    })
    .catch((error) => {
      log.error(`provision ${hash}: ${error.message}`);
      entry.state = 'error';
      entry.message = error.message;
      // Forget the failure after a bit so a page refresh can retry.
      setTimeout(() => {
        if (provisions.get(hash) === entry) provisions.delete(hash);
      }, 15_000).unref();
    })
    .finally(() => provisionEvents.emit('status', hash, entry));

  return entry;
}

async function provision(hash, log) {
  const deadline = Date.now() + config.provisionTimeoutMs;

  let container = await findContainer(hash);

  // A failed create leaves a dead record behind; clear it and start over.
  if (container?.status === 'failed') {
    log.warn(`deleting failed container ${containerHostname(hash)} (id ${container.id})`);
    await deleteContainer(container.id);
    container = null;
  }

  if (!container) {
    log.info(`creating container ${containerHostname(hash)}`);
    container = await createContainer(hash);
  }

  // GET returns `creationJobId`; the POST create response calls it `jobId`.
  const jobId = container?.creationJobId ?? container?.jobId;
  if (jobId != null) {
    await waitForJob(jobId, deadline);
  } else if (container?.status === 'creating') {
    await waitForContainerStatus(hash, deadline);
  }

  // The job finishing isn't enough; wait for the URL to actually serve.
  await waitForReachable(hash, deadline, log);
}
