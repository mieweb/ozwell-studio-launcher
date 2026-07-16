/**
 * Studio business logic: what studios a user has and starting new ones.
 * Naming lives in naming.js; the background create workflow lives in
 * provisioner.js.
 *
 * Status vocabulary (used verbatim in REST payloads, socket `status`
 * events, and the client):
 *   - launcher-derived: 'creating' (in-flight), 'running' (create
 *     finished and reachable), 'failed' (create errored)
 *   - manager-reported: whatever the manager says for existing
 *     containers ('running', 'offline', 'missing', ...), passed through.
 */
import { config } from '../config.js';
import * as manager from '../clients/manager.js';
import { studioUrlFrom } from './naming.js';
import provisioner from './provisioner.js';

const templateRef = manager.normalizeDockerRef(config.template);

/**
 * Merge the manager's container rows with in-flight provisioning entries
 * (a Map keyed by hostname) into the API's studio list: configured
 * template only, newest first, in-flight state folded in. Pure; exported
 * for tests.
 */
export function mergeStudios(rows, provisions) {
  const studios = rows
    .filter((c) => manager.normalizeDockerRef(c.template ?? '') === templateRef)
    .map((c) => ({
      hostname: c.hostname,
      status: provisions.get(c.hostname)?.status === 'creating' ? 'creating' : c.status,
      url: studioUrlFrom(c),
      createdAt: c.createdAt ?? null,
    }))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // Fold in creates so fresh POSTs are visible even before the manager
  // lists them.
  const known = new Set(studios.map((s) => s.hostname));
  for (const p of provisions.values()) {
    if (!known.has(p.hostname) && p.status === 'creating') {
      studios.unshift({ hostname: p.hostname, status: 'creating', url: p.url, createdAt: null });
    }
  }
  return studios;
}

/** The user's studios, with any in-flight provisioning state folded in. */
async function list(username) {
  const rows = await manager.listContainers(username);
  const provisions = new Map(provisioner.inflight(username).map((p) => [p.hostname, p]));
  return mergeStudios(rows, provisions);
}

/** Start creating a new studio; progress is emitted on `events`. */
function create(username) {
  return provisioner.start(username);
}

export default { list, create, events: provisioner.events };
