/**
 * Background provisioning of studio containers: create the container in
 * the manager, follow its create job, then wait for the load balancer to
 * actually serve the page. Emits `status` events as creates finish.
 */
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as manager from '../clients/manager.js';
import { newId, hostnameFor, studioUrl } from './naming.js';

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

/** Kick off creation of a brand-new studio container for `username`. */
function start(username) {
  const id = newId();
  const hostname = hostnameFor(id);
  const entry = { hostname, owner: username, status: 'creating', url: studioUrl(id) };
  provisions.set(hostname, entry);

  // One logger per provisioning job: the workflow outlives the request
  // that started it, so it gets its own child rather than a request log.
  const log = logger.child({ provision: hostname, username });

  provision(id, username, entry, log)
    .then(() => {
      entry.status = 'running';
    })
    .catch((error) => {
      log.error(`provision ${hostname}: ${error.message}`);
      entry.status = 'failed';
      entry.message = error.message;
    })
    .finally(() => {
      events.emit('status', entry);
      setTimeout(() => provisions.delete(hostname), 60_000).unref();
    });

  return entry;
}

/** The full background workflow for one create. */
async function provision(id, username, entry, log) {
  const deadline = Date.now() + config.provisionTimeoutMs;
  log.info(`creating container ${entry.hostname} for ${username}`);
  const created = await createContainer(id, username);
  const jobId = created?.jobId ?? created?.creationJobId;
  if (jobId != null) await waitForJob(jobId, deadline);
  // The job finishing isn't enough; wait for the URL to actually serve.
  await waitForReachable(entry.url, deadline, log);
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

export default { start, inflight, events };
