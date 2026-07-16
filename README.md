# ozwell-studio-launcher

A stupid-simple web server that gives every authenticated user their own
Ozwell Studio container.

## How it works

1. The forward-auth proxy sets a username header (`USER_HEADER`).
2. The app lists the user's containers that were created from the
   configured `TEMPLATE` (ownership is enforced by the manager; creates
   pass the username as the owner, which requires an admin API key).
3. **New Studio** creates a container named `<HOSTNAME_PREFIX>-<random id>`
   through the
   [Create-a-Container manager API](https://manager.os.mieweb.org/api/v1/openapi.yaml),
   with two HTTP services: `https://{id}.{EXTERNAL_DOMAIN}` → port 3000
   (the app) and `https://{id}-studio.{EXTERNAL_DOMAIN}` → port 6080 (the
   studio UI). The studio service is created with `authRequired` so the
   load balancer fronts it with auth.
4. The launcher polls the create job, then probes the studio URL until the
   load balancer control plane (which can lag up to a minute) actually
   serves it (302 = up and redirecting to auth; 404 = route not published
   yet, keep waiting; 502/503 = open anyway and let the load balancer's
   error page explain). Progress is pushed to the page over socket.io and
   the new studio opens automatically when ready.
5. Clicking an existing studio opens it directly.

## Running

```sh
cp .env.example .env   # edit values
make deps              # Node 24+; installs server + client dependencies
make build             # builds the React client (client/ -> client/dist)
npm start
```

Both the server (`Makefile`) and the client (`client/Makefile`) support:

| Target | Server | Client |
| --- | --- | --- |
| `deps` | server + client dependencies | client dependencies |
| `build` | builds the client bundle | production build to `dist/` |
| `test` | server test suite (`npm test`) | — |
| `install` | full app to `$(DESTDIR)$(PREFIX)` (default `/opt/ozwell-studio-launcher`) with production `node_modules`, plus the systemd unit to `$(DESTDIR)$(LIBDIR)/systemd/system` | `dist/` to `$(DESTDIR)$(PREFIX)/client/dist` |
| `dev` | `node --watch` server + client rebuild on change | Vite dev server (HMR, `/api` and `/socket.io` proxied to `:3000`) |

Server tests (`node:test`, no extra dependencies):

```sh
make test   # or: npm test
```

To run under systemd, put the environment (see `.env.example`) in
`/etc/default/ozwell-studio-launcher`, then:

```sh
sudo make install
sudo systemctl enable --now ozwell-studio-launcher
```

The unit template (`contrib/ozwell-studio-launcher.service.in`, `@PREFIX@`
substituted at install) runs the server as a transient unprivileged user
(`DynamicUser`) with filesystem/kernel hardening.

`.env` is loaded from the working directory via Node's native
`process.loadEnvFile()`; real environment variables take precedence.

Or with Docker:

```sh
docker build -t ozwell-studio-launcher .
docker run --env-file .env -p 3000:3000 ozwell-studio-launcher
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `USER_HEADER` | `remote-user` | Header (case-insensitive) with the authenticated username |
| `USER_GROUP_HEADER` | `x-forwarded-groups` | Header with the user's groups, comma-separated (oauth2-proxy convention) |
| `AUTHORIZED_GROUPS` | — | Comma-separated groups allowed access; empty = any authenticated user |
| `ALLOWED_PROXIES` | — | IPs/CIDRs whose auth headers are trusted (e.g. `10.0.0.5, 192.168.0.0/16`); empty = anywhere |
| `MANAGER_URL` | `https://manager.os.mieweb.org` | Manager base URL |
| `MANAGER_API_KEY` | — | Bearer API key for the manager. Must be an **admin** key: creates pass the authenticated user as the container's `username` (owner) |
| `SITE_ID` | `1` | Manager site id containers are created in |
| `TEMPLATE` | `ozwell-studio` | Container template |
| `HOSTNAME_PREFIX` | `ozwell-studio` | Prefix for the container's hostname in the manager (not user-facing) |
| `EXTERNAL_DOMAIN` | `os.mieweb.org` | External domain the HTTP services are published under (must exist in the manager) |
| `EXTERNAL_SCHEME` | `https` | Scheme for the published URLs (handy for http staging setups) |
| `APP_PORT` | `3000` | Container port behind `https://{id}.{EXTERNAL_DOMAIN}` |
| `STUDIO_PORT` | `6080` | Container port behind `https://{id}-studio.{EXTERNAL_DOMAIN}` (what "open" launches) |
| `STUDIO_PATH` | `/studio/` | Path users are sent to on the studio service |
| `POLL_INTERVAL_MS` | `3000` | Create-job poll interval |
| `PROVISION_TIMEOUT_MS` | `600000` | Give up on provisioning after this long |

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | The studio list app |
| `/api/v1/studios` | GET: the user's studios; POST: create a new one |
| `/socket.io/` | Socket.io channel pushing provisioning `status` events |
| `/healthz` | Liveness probe (no auth) |

## Layout

```
src/
  server.js        Bootstrap: plugins, auth hook, SPA shell, listen
  auth.js          Forward-auth trust (proxy allow-list, groups, open paths)
  socket.js        Socket.io wiring (provisioning status pushes)
  studios/         The studios feature
    routes.js        HTTP surface (routes + request/response shaping)
    service.js       Business logic: listing, starting creates
    naming.js        Id/hostname/URL helpers
    provisioner.js   Background create workflow (job poll, reachability)
  clients/
    manager.js       Manager API client (gateway, not a repository)
  config.js        Environment variables (validated at load)
test/         node:test suites for the pure seams (auth, naming, merge,
              Docker-ref normalization, config validation)
client/       Vite + React app built on @mieweb/ui (ui.mieweb.org components);
              lists studios, creates new ones, opens them when ready
```

Layering is intentionally minimal for a one-feature app; the boundaries
that carry real complexity are `auth.js` (trust model), `provisioner.js`
(create workflow), and `clients/manager.js` (wire protocol). Grow layers
only when a feature earns them: add a controller file once a feature has
more than a handful of routes, and a top-level router once there are
several features. Studio statuses use one vocabulary end to end —
launcher-derived `creating`/`running`/`failed` plus manager-reported
statuses passed through — in REST payloads, socket `status` events, and
the client.

Known constraint: in-flight provisioning state lives in memory
(`provisioner.js`), so the launcher is single-instance; a restart during
a create loses its progress events (the manager still owns the container
itself).
