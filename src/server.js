/**
 * ozwell-studio-launcher
 *
 * Sits behind a forward-auth proxy and lets every authenticated user
 * manage their own Ozwell Studio containers:
 *
 *   - GET  /                   the React app: lists the user's studios
 *   - GET  /api/v1/studios  the user's studios (configured template only)
 *   - POST /api/v1/studios  create a new studio container
 *   - socket.io                pushes provisioning status for the user's creates
 *
 * Organized by feature: each feature dir (studios/) owns its routes ->
 * service (-> background workers); clients/ holds the Manager API client
 * (an API gateway, not a repository: the manager owns the data). This
 * file only bootstraps: plugins, auth hook, SPA shell, socket, listen.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { logger } from './logger.js';
import { authenticate, isOpenPath } from './auth.js';
import { sequelize } from './db/index.js';
import { migrate } from './db/migrate.js';
import studios from './studios/service.js';
import studioRoutes from './studios/routes.js';
import { attachSocket } from './socket.js';

const app = Fastify({ loggerInstance: logger });

if (!config.managerApiKey) {
  app.log.warn('MANAGER_API_KEY is not set; manager API calls will fail');
}

/** Bring the database up to date before serving anything that uses it. */
await migrate(sequelize);

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

/** Pages and the API require the trusted proxy + username header. */
app.addHook('preHandler', async (request, reply) => {
  if (isOpenPath(request.url)) return;

  const { username, denied } = authenticate(request.socket.remoteAddress, request.headers);
  if (denied) {
    request.log.warn(
      { remoteAddress: request.socket.remoteAddress, reason: denied.message },
      'request denied'
    );
    if (request.url.startsWith('/api/')) {
      return reply.code(denied.code).send({ error: denied.message });
    }
    return sendApp(reply, denied.code);
  }
  request.username = username;
});

/** The studio list app. */
app.get('/', async (request, reply) => sendApp(reply));

await app.register(studioRoutes, { prefix: '/api/v1/studios' });

app.setNotFoundHandler((request, reply) =>
  request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'Not found' })
    : sendApp(reply, 404)
);

await app.ready();
attachSocket(app.server);

await app.listen({ port: config.port, host: '0.0.0.0' });

// Pre-build studios up to POOL_SIZE in the background.
studios.topUpPool();
