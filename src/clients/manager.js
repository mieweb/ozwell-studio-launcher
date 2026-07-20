/**
 * HTTP client for the Create-a-Container manager API.
 *
 * Deliberately a thin API client (not a repository): the manager owns the
 * data and its lifecycle — this module only speaks the wire protocol,
 * mirrors manager-side normalization, and caches nothing except the
 * external-domain id (immutable for the life of the process).
 *
 * API spec: https://manager.os.mieweb.org/api/v1/openapi.yaml
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'manager-api' });

/**
 * Minimal fetch wrapper: bearer auth, JSON, unwraps the `{ data }` envelope.
 * Every request/response is logged at debug level (LOG_LEVEL=debug).
 */
async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const url = `${config.managerUrl}/api/v1${path}`;
  const requestBody = options.body ? JSON.parse(options.body) : undefined;
  log.debug({ method, url, body: requestBody }, 'manager API request');

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
  log.debug(
    { method, url, status: response.status, elapsedMs: Date.now() - started, response: body },
    'manager API response'
  );

  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Manager API ${method} ${path}: ${message}`);
  }
  return body?.data ?? body;
}

/**
 * Normalize a Docker image reference the way the manager does, so template
 * comparisons survive the manager's canonicalization (host/org/image:tag).
 *
 * COUPLING: this deliberately mirrors the manager's own normalization
 * (mieweb/opensource-server) and will silently mis-filter if the manager
 * changes its rules. The expected behavior is pinned by
 * test/manager.test.js; ideally the manager would expose a normalized
 * template field so this mirror can be deleted.
 */
export function normalizeDockerRef(ref) {
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('git@')) return ref;
  let tag = 'latest';
  let imagePart = ref;
  const lastColon = ref.lastIndexOf(':');
  if (lastColon !== -1) {
    const potentialTag = ref.slice(lastColon + 1);
    if (!potentialTag.includes('/')) {
      tag = potentialTag;
      imagePart = ref.slice(0, lastColon);
    }
  }
  const parts = imagePart.split('/');
  let host = 'docker.io';
  let org = 'library';
  let image;
  if (parts.length === 1) {
    image = parts[0];
  } else if (parts.length === 2) {
    if (parts[0].includes('.') || parts[0].includes(':')) {
      host = parts[0];
      image = parts[1];
    } else {
      org = parts[0];
      image = parts[1];
    }
  } else {
    host = parts[0];
    image = parts[parts.length - 1];
    org = parts.slice(1, -1).join('/');
  }
  return `${host}/${org}/${image}:${tag}`;
}

/** Containers visible for the given owner (admin keys see any owner's). */
export async function listContainers(username) {
  const params = new URLSearchParams({ 'user[0]': username });
  const rows = await api(`/sites/${config.siteId}/containers?${params}`);
  return rows ?? [];
}

/** The container with the given hostname, or null when it does not exist. */
export async function getContainerByHostname(hostname) {
  const params = new URLSearchParams({ hostname });
  const rows = await api(`/sites/${config.siteId}/containers?${params}`);
  return rows?.[0] ?? null;
}

/** Enqueue a container create. Returns `{ containerId, jobId, hostname, status }`. */
export async function createContainer(payload) {
  return api(`/sites/${config.siteId}/containers`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Update a container. Used to reassign ownership (`{ username }`) when a
 * pooled studio is claimed; like creates, changing the owner requires an
 * admin API key.
 */
export async function updateContainer(containerId, fields) {
  return api(`/sites/${config.siteId}/containers/${containerId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

/** Job metadata: `{ id, status, ... }`. */
export async function getJob(jobId) {
  return api(`/jobs/${jobId}`);
}

/**
 * Resolve the configured external domain name to its manager id, using the
 * create-form bootstrap endpoint (available to non-admin API keys).
 * Cached for the process lifetime.
 */
let cachedDomainId = null;
export async function externalDomainId() {
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
