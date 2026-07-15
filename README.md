# ozwell-studio-launcher

A stupid-simple web server that gives every authenticated user their own
Ozwell Studio container.

## How it works

1. The forward-auth proxy sets a username header (`USER_HEADER`).
2. The launcher derives a stable hash from the username
   (`sha256(lowercase username)`, first `HASH_LENGTH` hex chars). The
   container is registered in the manager as `<HOSTNAME_PREFIX>-<hash>`.
3. Containers are created with two HTTP services with short public URLs:
   `https://{hash}.{EXTERNAL_DOMAIN}` → port 3000 (the app) and
   `https://{hash}-studio.{EXTERNAL_DOMAIN}` → port 6080 (the studio
   UI, and the redirect target). The studio service is created with
   `authRequired` so the load balancer fronts it with auth.
4. **Container exists** → immediate `302` redirect to it.
5. **Container missing** → a branded please-wait page is shown while the
   launcher creates the container through the
   [Create-a-Container manager API](https://manager.os.mieweb.org/api/v1/openapi.yaml)
   and polls the create job. The load balancer control plane can lag up to
   a minute behind the job, so the launcher then probes the studio URL until
   it responds (302 = up and redirecting to auth; 404 = route not published
   yet, keep waiting; 502/503 = redirect anyway and let the load balancer's
   error page explain). The page listens on a socket.io channel and
   auto-redirects when the server pushes the `ready` status.

Provisioning is idempotent per hostname; concurrent requests share the same
in-flight job.

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
| `install` | full app to `$(DESTDIR)$(PREFIX)` (default `/opt/ozwell-studio-launcher`) with production `node_modules`, plus the systemd unit to `$(DESTDIR)$(LIBDIR)/systemd/system` | `dist/` to `$(DESTDIR)$(PREFIX)/client/dist` |
| `dev` | `node --watch` server + client rebuild on change | Vite dev server (HMR, `/socket.io` proxied to `:3000`) |

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
| `HASH_LENGTH` | `12` | Hex chars of the sha256 username hash |
| `EXTERNAL_DOMAIN` | `os.mieweb.org` | External domain the HTTP services are published under (must exist in the manager) |
| `EXTERNAL_SCHEME` | `https` | Scheme for the published URLs (handy for http staging setups) |
| `APP_PORT` | `3000` | Container port behind `https://{hash}.{EXTERNAL_DOMAIN}` |
| `STUDIO_PORT` | `6080` | Container port behind `https://{hash}-studio.{EXTERNAL_DOMAIN}` (the redirect target) |
| `STUDIO_PATH` | `/studio/` | Path users are sent to on the studio service |
| `POLL_INTERVAL_MS` | `3000` | Create-job poll interval |
| `PROVISION_TIMEOUT_MS` | `600000` | Give up on provisioning after this long |

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | Redirect or please-wait page |
| `/socket.io/` | Socket.io channel pushing `status` events to the wait page |
| `/healthz` | Liveness probe (no auth) |

## Layout

```
src/
  server.js   Fastify app, routes, socket.io wiring
  manager.js  Manager API client + provisioning state machine
  config.js   Environment variables
client/       Vite + React app built on @mieweb/ui (ui.mieweb.org components);
              renders the wait/error screens, redirects on socket 'ready'
```
