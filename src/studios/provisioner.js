/**
 * Background provisioning of studio containers, and the warm pool that
 * makes it fast. Two ways a user gets a studio:
 *
 *   - claim: when POOL_SIZE > 0 and the pool has a pre-built studio, it
 *     is taken FIFO, its owner is reassigned to the user in the manager
 *     (before the user is redirected to it), and one quick reachability
 *     probe confirms it still serves.
 *   - fresh create: otherwise, create the container in the manager,
 *     follow its create job, then wait for the load balancer to actually
 *     serve the page.
 *
 * Either way, `status` events are emitted as work finishes, and the pool
 * is topped back up to POOL_SIZE in the background (pool containers are
 * created without a username, so they belong to the API key's user until
 * claimed — which also keeps them out of users' listings).
 */
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as manager from '../clients/manager.js';
import * as pool from './pool.js';
import { newId, hostnameFor, studioUrl, studioUrlFrom } from './naming.js';

/**
 * In-flight provisioning state, keyed by container hostname. Each entry is
 * { hostname, owner, status: 'creating' | 'running' | 'failed', url?,
 * message? } — the launcher-derived part of the status vocabulary
 * documented in service.js. Entries exist only for the duration of a
 * create (plus a short grace so late subscribers still see the terminal
 * status); the manager remains the source of truth for what exists.
 */
const provisions = new Map();

/** Emits `status(entry)` whenever a provision changes status. */
const events = new EventEmitter().setMaxListeners(0);

/** In-flight provisions owned by a user. */
function inflight(username) {
  return [...provisions.values()].filter((p) => p.owner === username);
}

/**
 * Get `username` a studio: claim one from the pool when available,
 * otherwise create a fresh one. Returns the in-flight entry; progress is
 * emitted on `events`.
 */
async function start(username) {
  const pooled = config.poolSize > 0 ? await takePooled() : null;
  const entry = pooled ? claim(pooled, username) : createFresh(username);
  replenish(); // fire and forget; keeps the pool at POOL_SIZE
  return entry;
}

/**
 * Take pool entries FIFO until one still exists in the manager (rows can
 * go stale if a container is deleted out-of-band). Returns the container
 * record, or null when the pool is empty. On a manager error the row is
 * returned to the pool — the container is fine, we just couldn't ask.
 */
async function takePooled() {
  for (;;) {
    const hostname = await pool.take();
    if (!hostname) return null;
    let container;
    try {
      container = await manager.getContainerByHostname(hostname);
    } catch (error) {
      await pool.add(hostname).catch(() => {});
      throw error;
    }
    if (container) return container;
    logger.warn(`pool studio ${hostname} is gone from the manager; dropping it`);
  }
}

/** Track a background workflow as an in-flight entry, emitting at the end. */
function track(entry, log, workflow) {
  provisions.set(entry.hostname, entry);
  workflow
    .then(() => {
      entry.status = 'running';
    })
    .catch((error) => {
      log.error(`provision ${entry.hostname}: ${error.message}`);
      entry.status = 'failed';
      entry.message = error.message;
    })
    .finally(() => {
      events.emit('status', entry);
      setTimeout(() => provisions.delete(entry.hostname), 60_000).unref();
    });
  return entry;
}

/** Hand a pre-built pooled studio to `username`. */
function claim(container, username) {
  const entry = {
    hostname: container.hostname,
    owner: username,
    status: 'creating',
    url: studioUrlFrom(container),
  };
  // One logger per job: the workflow outlives the request that started it.
  const log = logger.child({ provision: entry.hostname, username, pooled: true });
  return track(entry, log, claimWorkflow(container, username, entry, log));
}

/** Reassign ownership, then confirm the studio still serves. */
async function claimWorkflow(container, username, entry, log) {
  log.info(`assigning pooled studio ${container.hostname} to ${username}`);
  try {
    // Reassign the owner before the user is redirected to the studio.
    await manager.updateContainer(container.id, { username });
  } catch (error) {
    // Ownership unchanged, so the studio is still good: back in the pool.
    await pool.add(container.hostname).catch(() => {});
    throw error;
  }
  await waitForReachable(entry.url, Date.now() + config.provisionTimeoutMs, log);
}

/** Kick off creation of a brand-new studio container for `username`. */
function createFresh(username) {
  const id = newId();
  const entry = {
    hostname: hostnameFor(id),
    owner: username,
    status: 'creating',
    url: studioUrl(id),
  };
  const log = logger.child({ provision: entry.hostname, username });
  log.info(`creating container ${entry.hostname} for ${username}`);
  return track(entry, log, provisionContainer(id, username, entry.url, log));
}

/**
 * The full create workflow: enqueue the container, follow its create job,
 * then wait until the studio URL actually serves.
 */
async function provisionContainer(id, username, url, log) {
  const deadline = Date.now() + config.provisionTimeoutMs;
  const created = await createContainer(id, username);
  const jobId = created?.jobId ?? created?.creationJobId;
  if (jobId != null) await waitForJob(jobId, deadline);
  // The job finishing isn't enough; wait for the URL to actually serve.
  await waitForReachable(url, deadline, log);
}

/**
 * Top the pool up to POOL_SIZE, one studio at a time. Runs at startup and
 * after every claim/create; overlapping calls coalesce. A failed create
 * logs and retries later rather than looping hot.
 */
let replenishing = false;
function replenish() {
  if (config.poolSize <= 0 || replenishing) return;
  replenishing = true;
  const log = logger.child({ module: 'pool' });
  replenishLoop(log)
    .catch((error) => {
      log.error(`pool replenish: ${error.message}; retrying in 60s`);
      setTimeout(replenish, 60_000).unref();
    })
    .finally(() => {
      replenishing = false;
    });
}

async function replenishLoop(log) {
  while ((await pool.count()) < config.poolSize) {
    const id = newId();
    const hostname = hostnameFor(id);
    log.info(`provisioning pool studio ${hostname}`);
    // No username: pool containers belong to the API key's user until claimed.
    await provisionContainer(id, undefined, studioUrl(id), log);
    await pool.add(hostname);
    log.info(`pool studio ${hostname} ready`);
  }
}

/**
 * Create the container with the traditional pair of HTTP services:
 *   {id}.{domain}         -> APP_PORT    (the app itself)
 *   {id}-studio.{domain}  -> STUDIO_PORT (the studio UI)
 *
 * `username` sets the container's owner. The manager only honors it when
 * the API key belongs to an admin; the container is owned by the key's
 * user otherwise.
 */
async function createContainer(id, username) {
  const domainId = await manager.externalDomainId();
  return manager.createContainer({
    hostname: hostnameFor(id),
    username,
    template: config.template,
    services: [
      {
        type: 'http',
        internalPort: config.appPort,
        externalHostname: id,
        externalDomainId: domainId,
      },
      {
        type: 'http',
        internalPort: config.studioPort,
        externalHostname: `${id}-studio`,
        externalDomainId: domainId,
        // The load balancer fronts the studio with the auth proxy, so an
        // unauthenticated probe of a healthy service gets a 302 to auth.
        authRequired: true,
      },
    ],
  });
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
    const { status } = await manager.getJob(jobId);
    if (JOB_SUCCESS.has(status)) return;
    if (!JOB_IN_PROGRESS.has(status)) {
      throw new Error(`Container creation job ended with status "${status}".`);
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
 *   502/503      -> route is up but the backend errored; open anyway and
 *                   let the load balancer's error page explain
 *   no response  -> DNS/connect failure; keep waiting
 * Anything else (200, 401, ...) also counts as reachable.
 */
async function waitForReachable(url, deadline, log) {
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
    log.debug({ url, status }, 'reachability probe');

    if (status === null || status === 404) {
      await sleep(config.pollIntervalMs);
      continue;
    }
    if (status === 502 || status === 503) {
      log.warn(`${url} responded ${status}; opening anyway so the load balancer can explain`);
    }
    return;
  }
  throw new Error('Timed out waiting for the workspace to become reachable.');
}

export default { start, inflight, events, replenish };
