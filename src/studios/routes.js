/**
 * Studios feature HTTP surface: routes plus request/response shaping.
 * Business logic lives in service.js. Mounted by server.js under
 * /api/v1/studios; auth is enforced by the server-wide preHandler hook
 * before any of these run.
 *
 * (Deliberately routes-only: add a separate controller layer only if a
 * feature grows past a handful of routes with real HTTP shaping.)
 */
import service from './service.js';

export default async function routes(app) {
  /** GET /api/v1/studios — the user's studios. */
  app.get('/', async (request) => ({ studios: await service.list(request.username) }));

  /** POST /api/v1/studios — start a create; progress arrives via socket.io. */
  app.post('/', async (request, reply) => {
    const { hostname, status, url } = service.create(request.username);
    return reply.code(201).send({ studio: { hostname, status, url } });
  });
}
