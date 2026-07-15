/**
 * ozwell-studio-launcher
 *
 * Sits behind a forward-auth proxy and gives every authenticated user
 * their own Ozwell Studio container:
 *
 *   1. Derives a stable hash from the authenticated-user header.
 *   2. Container already exists  -> 302 to it immediately.
 *   3. Container missing         -> branded please-wait page while the
 *      container is created via the manager API; the page listens on a
 *      socket.io channel and redirects itself when the create job finishes.
 */
import net from 'node:net';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import handlebars from 'handlebars';
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

if (!config.managerApiKey) {
  app.log.warn('MANAGER_API_KEY is not set; manager API calls will fail');
}

await app.register(fastifyView, {
  engine: { handlebars },
  root: path.join(import.meta.dirname, 'views'),
  layout: 'layout.hbs',
});

await app.register(fastifyStatic, {
  root: path.join(import.meta.dirname, 'public'),
  prefix: '/assets/',
});

/** Liveness probe (no auth). */
app.get('/healthz', async () => 'ok\n');

/** Pages require the username header from the proxy; assets do not. */
app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/healthz' || request.url.startsWith('/assets/')) return;
  if (!isTrustedProxy(request.socket.remoteAddress)) {
    request.log.warn({ remoteAddress: request.socket.remoteAddress }, 'request from untrusted peer');
    return reply.code(403).view('error.hbs', {
      title: 'Forbidden',
      message: 'Direct access is not allowed. Please go through the authentication proxy.',
    });
  }
  const username = request.headers[config.userHeader];
  if (!username) {
    return reply.code(401).view('error.hbs', {
      title: 'Not authenticated',
      message: `Missing "${config.userHeader}" header. This service must be accessed through the authentication proxy.`,
    });
  }
  if (!isAuthorized(request.headers)) {
    request.log.warn(
      { username, groups: requestGroups(request.headers) },
      'user not in an authorized group'
    );
    return reply.code(403).view('error.hbs', {
      title: 'Not authorized',
      message: 'Your account is not in a group that is allowed to use Ozwell Studio.',
    });
  }
  request.userHash = userHash(String(username));
});

/** Redirect straight to the container, or show the please-wait page. */
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
      return reply.code(502).view('error.hbs', {
        title: 'Service unavailable',
        message: 'Could not reach the container manager. Please try again shortly.',
      });
    }
    if (container && !['creating', 'failed'].includes(container.status)) {
      return reply.redirect(containerUrl(hash), 302);
    }
  }

  // Slow path: start provisioning and show the wait page.
  ensureProvision(hash, request.log);
  return reply.view('wait.hbs', { title: 'Setting up your workspace' });
});

app.setNotFoundHandler((request, reply) =>
  reply.code(404).view('error.hbs', { title: 'Not found', message: 'This page does not exist.' })
);

/**
 * Socket.io: the wait page connects here and gets pushed `status` events
 * ({ state: 'creating' | 'ready' | 'error', url?, message? }) until the
 * container is ready. Auth uses the same proxy header as HTTP requests.
 */
await app.ready();
const io = new SocketIOServer(app.server, { serveClient: true });

io.on('connection', (socket) => {
  if (!isTrustedProxy(socket.conn.remoteAddress)) {
    socket.emit('status', { state: 'error', message: 'Direct access is not allowed.' });
    return socket.disconnect(true);
  }
  const username = socket.handshake.headers[config.userHeader];
  if (!username) {
    socket.emit('status', { state: 'error', message: 'Not authenticated.' });
    return socket.disconnect(true);
  }
  if (!isAuthorized(socket.handshake.headers)) {
    socket.emit('status', {
      state: 'error',
      message: 'Your account is not in a group that is allowed to use Ozwell Studio.',
    });
    return socket.disconnect(true);
  }
  const hash = userHash(String(username));

  // Push the current state right away, then every change until disconnect.
  socket.emit('status', ensureProvision(hash, app.log));
  const forward = (changedHash, entry) => {
    if (changedHash === hash) socket.emit('status', entry);
  };
  provisionEvents.on('status', forward);
  socket.on('disconnect', () => provisionEvents.off('status', forward));
});

await app.listen({ port: config.port, host: '0.0.0.0' });
