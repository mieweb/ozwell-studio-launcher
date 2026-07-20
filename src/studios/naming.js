/**
 * Studio naming helpers. Each studio gets a random short id: the container
 * record in the manager is named `{HOSTNAME_PREFIX}-{id}` so it's
 * identifiable, while the public URLs stay short: `{id}.{domain}` and
 * `{id}-studio.{domain}`.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Random short id for a new studio. */
export function newId() {
  return randomBytes(4).toString('hex');
}

/** The container's hostname in the manager (not user-facing). */
export function hostnameFor(id) {
  return config.hostnamePrefix ? `${config.hostnamePrefix}-${id}` : id;
}

/** The public id is the hostname minus the optional prefix. */
export function idFrom(hostname) {
  return config.hostnamePrefix ? hostname.replace(`${config.hostnamePrefix}-`, '') : hostname;
}

/** The one place a studio URL is assembled from its published hostname. */
function urlFor(externalHostname, domain) {
  return `${config.externalScheme}://${externalHostname}.${domain}${config.studioPath}`;
}

/**
 * Where users land for a given studio id, by naming convention. Used for
 * brand-new studios before the manager record exists; studioUrlFrom() is
 * preferred once there is a container record.
 */
export function studioUrl(id) {
  return urlFor(`${id}-studio`, config.externalDomain);
}

/**
 * Studio URL from the container's own service records (source of truth),
 * falling back to the naming convention when the record has no studio
 * service.
 */
export function studioUrlFrom(container) {
  const studio = (container.services ?? []).find(
    (s) => s.internalPort === config.studioPort && s.httpService
  );
  if (!studio) return studioUrl(idFrom(container.hostname));
  return urlFor(studio.httpService.externalHostname, studio.httpService.domain ?? config.externalDomain);
}
