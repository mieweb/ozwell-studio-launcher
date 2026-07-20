/**
 * Forward-auth trust: only requests arriving from an allowed proxy with
 * the expected identity headers may use the app. Shared by the HTTP
 * preHandler hook and the socket.io connection handler.
 */
import net from 'node:net';
import { config } from './config.js';

/**
 * The proxy allow-list: auth headers are only trusted when the TCP peer is
 * one of these addresses. Empty ALLOWED_PROXIES disables the check.
 */
const allowedProxies = config.allowedProxies.length > 0 ? new net.BlockList() : null;
for (const entry of config.allowedProxies) {
  const [address, prefix] = entry.split('/');
  if (net.isIP(address) === 0) {
    throw new Error(`ALLOWED_PROXIES entry "${entry}" is not a valid IP or CIDR`);
  }
  const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (prefix != null) allowedProxies.addSubnet(address, Number(prefix), family);
  else allowedProxies.addAddress(address, family);
}

/** Is this TCP peer a proxy we trust? (IPv4-mapped IPv6 is normalized.) */
function isTrustedProxy(remoteAddress) {
  if (!allowedProxies) return true;
  if (!remoteAddress) return false;
  const v4 = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  return net.isIP(v4) === 4
    ? allowedProxies.check(v4, 'ipv4')
    : allowedProxies.check(remoteAddress, 'ipv6');
}

/**
 * Parse the groups header the way oauth2-proxy sends it: a comma-separated
 * list (possibly repeated as multiple header values).
 */
function requestGroups(headers) {
  const raw = headers[config.userGroupHeader];
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((value) => value.split(','))
    .map((group) => group.trim())
    .filter(Boolean);
}

/** True when no group restriction is configured or the user is in one. */
function isAuthorized(headers) {
  if (config.authorizedGroups.length === 0) return true;
  return requestGroups(headers).some((group) => config.authorizedGroups.includes(group));
}

/**
 * Auth verdict. Returns null when the caller may proceed, or
 * { code, message } describing the rejection.
 */
function denyReason(remoteAddress, headers) {
  if (!isTrustedProxy(remoteAddress)) {
    return {
      code: 403,
      message: 'Direct access is not allowed. Please go through the authentication proxy.',
    };
  }
  if (!headers[config.userHeader]) {
    return {
      code: 401,
      message: `Missing "${config.userHeader}" header. This service must be accessed through the authentication proxy.`,
    };
  }
  if (!isAuthorized(headers)) {
    return {
      code: 403,
      message: 'Your account is not in a group that is allowed to use Ozwell Studio.',
    };
  }
  return null;
}

/** The authenticated username from trusted proxy headers. */
function usernameFrom(headers) {
  return String(headers[config.userHeader]).trim();
}

/**
 * Paths that skip auth: the liveness probe and the static assets the SPA
 * shell needs even on an auth-error page.
 */
export function isOpenPath(url) {
  return url === '/healthz' || url.startsWith('/assets/') || url.startsWith('/favicon');
}

/**
 * The one auth entry point, shared by the HTTP preHandler hook and the
 * socket.io connection handler. Returns { username } when the caller may
 * proceed, or { denied: { code, message } } describing the rejection.
 */
export function authenticate(remoteAddress, headers) {
  const denied = denyReason(remoteAddress, headers);
  return denied ? { denied } : { username: usernameFrom(headers) };
}
