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
import * as pool from './pool.js';
import provisioner from './provisioner.js';

const templateRef = manager.normalizeDockerRef(config.template);

/**
 * Merge the manager's container rows with in-flight provisioning entries
 * (a Map keyed by hostname) into the API's studio list: configured
 * template only, newest first, in-flight state folded in. Studios whose
 * hostname is in `pooled` (a Set) are flagged `pooled: true` — pool
 * containers belong to the API key's user, so this only ever surfaces on
 * that user's dashboard, distinguishing warm-pool stock from their own
 * studios. Pure; exported for tests.
 */
export function mergeStudios(rows, provisions, pooled = new Set()) {
  const studios = rows
    .filter((c) => manager.normalizeDockerRef(c.template ?? '') === templateRef)
    .map((c) => ({
      hostname: c.hostname,
      status: provisions.get(c.hostname)?.status === 'creating' ? 'creating' : c.status,
      url: studioUrlFrom(c),
      createdAt: c.createdAt ?? null,
      pooled: pooled.has(c.hostname),
    }))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // Fold in creates so fresh POSTs are visible even before the manager
  // lists them. These are always user-requested, never pool stock.
  const known = new Set(studios.map((s) => s.hostname));
  for (const p of provisions.values()) {
    if (!known.has(p.hostname) && p.status === 'creating') {
      studios.unshift({
        hostname: p.hostname,
        status: 'creating',
        url: p.url,
        createdAt: null,
        pooled: false,
      });
    }
  }
  return studios;
}

/** The user's studios, with any in-flight provisioning state folded in. */
async function list(username) {
  const [rows, pooled] = await Promise.all([manager.listContainers(username), pool.hostnames()]);
  const provisions = new Map(provisioner.inflight(username).map((p) => [p.hostname, p]));
  return mergeStudios(rows, provisions, pooled);
}

/**
 * Get the user a new studio — claimed from the warm pool when one is
 * ready, freshly created otherwise. Resolves to the in-flight entry;
 * progress is emitted on `events`.
 */
function create(username) {
  return provisioner.start(username);
}

export default {
  list,
  create,
  events: provisioner.events,
  /** Top the warm pool up to POOL_SIZE (no-op when pooling is disabled). */
  topUpPool: provisioner.replenish,
};
