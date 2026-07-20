/**
 * The warm-studio pool: hostnames of pre-built containers waiting to be
 * claimed, stored in the database so the pool survives restarts. Only the
 * hostname is stored — everything else about a container is queried from
 * the manager. Claims are FIFO: the oldest entry goes first.
 */
import { models } from '../db/index.js';

const { PooledStudio } = models;

/** Add a freshly provisioned studio to the back of the pool. */
export async function add(hostname) {
  await PooledStudio.create({ hostname });
}

/**
 * Claim the oldest pooled hostname (FIFO), or null when the pool is
 * empty. The delete-count check makes concurrent takers (other requests
 * or instances) skip rows someone else already won.
 */
export async function take() {
  for (;;) {
    const row = await PooledStudio.findOne({ order: [['id', 'ASC']] });
    if (!row) return null;
    const deleted = await PooledStudio.destroy({ where: { id: row.id } });
    if (deleted === 1) return row.hostname;
  }
}

/** Number of studios currently waiting in the pool. */
export function count() {
  return PooledStudio.count();
}
