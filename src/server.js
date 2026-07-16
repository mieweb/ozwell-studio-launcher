/**
 * ozwell-studio-launcher
 *
 * Sits behind a forward-auth proxy and gives every authenticated user
 * their own Ozwell Studio container:
 *
 *   1. Derives a stable hash from the authenticated-user header.
 *   2. Container already exists  -> 302 to it immediately.
 *   3. Container missing         -> the React app (client/) shows a branded
 *      please-wait screen, listens on a socket.io channel, and redirects
 *      itself when the create job finishes.
 *
 * All page states (waiting, errors, not-found) are rendered by the SPA;
 * the server just picks the HTTP status code and pushes provisioning
 * status over socket.io.
 */
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  userHash,
  containerUrl,
  findContainer,
  ensureProvision,
  provisionStatus,
  provisionEvents,
} from './manager.js';

const app = Fastify({ loggerInstance: logger });

/**
 * The proxy allow-list: auth headers are only trusted when the TCP peer is
 * one of these addresses. Empty ALLOWED_PROXIES disables the check.
 */
const allowedProxies = config.allowedProxies.length > 0 ? new net.BlockList() : null;
for (const entry of config.allowedProxies) {
  const [address, prefix] = entry.split('/');
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
 * Auth verdict shared by HTTP and socket.io. Returns null when the caller
 * may proceed, or { code, message } describing the rejection.
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

if (!config.managerApiKey) {
  app.log.warn('MANAGER_API_KEY is not set; manager API calls will fail');
}

/** The built React app (client/) — hashed assets, favicons, index.html. */
const clientDist = path.join(import.meta.dirname, '..', 'client', 'dist');
await app.register(fastifyStatic, { root: clientDist });

/**
 * The SPA shell, held in memory and served with no-store so error statuses
 * are never entangled with conditional-request caching (a cached shell +
 * ETag revalidation turns a 401 into a bodiless response browsers choke on).
 */
const appShell = await readFile(path.join(clientDist, 'index.html'), 'utf8');
function sendApp(reply, code = 200) {
  return reply
    .code(code)
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(appShell);
}

/** Liveness probe (no auth). */
app.get('/healthz', async () => 'ok\n');

/** Pages require the trusted proxy + username header; assets do not. */
app.addHook('preHandler', async (request, reply) => {
  const openPath =
    request.url === '/healthz' ||
    request.url.startsWith('/assets/') ||
    request.url.startsWith('/favicon');
  if (openPath) return;

  const denied = denyReason(request.socket.remoteAddress, request.headers);
  if (denied) {
    request.log.warn(
      { remoteAddress: request.socket.remoteAddress, reason: denied.message },
      'request denied'
    );
    return sendApp(reply, denied.code);
  }
  request.userHash = userHash(String(request.headers[config.userHeader]));
});

/** Redirect straight to the container, or show the please-wait app. */
app.get('/', async (request, reply) => {
  const hash = request.userHash;

  // Fast path: the container already exists -> redirect, no interstitial.
  const provisioning = provisionStatus(hash)?.state === 'creating';
  if (!provisioning) {
    let container;
    try {
      container = await findContainer(hash);
    } catch (error) {
      request.log.error(`container lookup failed: ${error.message}`);
      return sendApp(reply, 502);
    }
    if (container && !['creating', 'failed'].includes(container.status)) {
      return reply.redirect(containerUrl(hash), 302);
    }
  }

  // Slow path: start provisioning and show the wait screen.
  ensureProvision(hash, request.log);
  return sendApp(reply);
});

app.setNotFoundHandler((request, reply) => sendApp(reply, 404));

/**
 * Socket.io: the wait screen connects here and gets pushed `status` events
 * ({ state: 'creating' | 'ready' | 'error', url?, message? }) until the
 * container is ready. Auth mirrors the HTTP hook.
 */
await app.ready();
const io = new SocketIOServer(app.server);

io.on('connection', (socket) => {
  const denied = denyReason(socket.conn.remoteAddress, socket.handshake.headers);
  if (denied) {
    socket.emit('status', { state: 'error', message: denied.message });
    return socket.disconnect(true);
  }
  const hash = userHash(String(socket.handshake.headers[config.userHeader]));

  // Push the current state right away, then every change until disconnect.
  socket.emit('status', ensureProvision(hash, app.log));
  const forward = (changedHash, entry) => {
    if (changedHash === hash) socket.emit('status', entry);
  };
  provisionEvents.on('status', forward);
  socket.on('disconnect', () => provisionEvents.off('status', forward));
});

await app.listen({ port: config.port, host: '0.0.0.0' });
