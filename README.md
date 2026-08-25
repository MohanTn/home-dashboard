# Container Manager

[![CI](https://github.com/MohanTn/home-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/home-dashboard/actions/workflows/ci.yml)

One password-gated page that manages every docker compose stack on your home
server. Each card knows the folder holding its `docker-compose.yml`: click it and
the manager brings the stack up, holds you on a loader until the app answers, then
hands you over. A stack nobody opens for 6 hours is taken back down, so the box
only runs what you are actually using.

Cards still route to the right URL for wherever you are (LAN, VPN, public domain).

No dependencies, no build step, no database. Node 20+ only.

## Run it

```bash
sudo DASHBOARD_PASSWORD='pick-something-long' npm start
# http://localhost
```

Port 5000 is the default, which needs no root on Linux. Pick another port with
`PORT=8787 npm start`. Point `STACKS_HOST_DIR` at the host folder that holds your
compose stacks. The manager mounts it at the same absolute path inside the
container, then discovers and runs the `docker-compose.yml` or `compose.yml` in
each selected app folder. Keeping the path identical is required for relative
bind mounts and build contexts.

## Run it in Docker

```bash
docker compose up -d --build
```

Edit `DASHBOARD_PASSWORD` in `docker-compose.yml` before the first start. The
`dashboard-data` volume holds `apps.json` and the session key, so cards you add
in the UI survive restarts and rebuilds. The manager needs two extra mounts to do
its job: your stacks folder (read-only, mapped to the configured `STACKS_HOST_DIR`
path) and `/var/run/docker.sock`. The socket is full control of the host daemon,
so keep the master password strong and do not expose this to the
internet without HTTPS and a reverse proxy in front. On startup, the image reads
the socket's group id, grants that group to the `node` user, and then drops
privileges. This avoids a host-specific hard-coded Docker group id.


Put your other containers on the same `homelab` network and their container
names work as hostnames in card URLs, e.g. `http://jellyfin:8096`.

## Managing stacks

Every card is one compose project. The `compose` field is a folder **relative to
`STACKS_DIR`** holding a `docker-compose.yml` (or `compose.yaml`), and nothing
outside that root can be started, so a bad catalog edit cannot point the manager
at an arbitrary directory.

- **Click a card** — if the stack is down, the manager runs `docker compose up -d`,
  shows a loader while the containers boot, polls both the app's health URL and
  `docker compose ps` until Compose reports a running service, then redirects you.
  A failure shows docker's own message with a Retry button.
- **Stop** on a card runs `docker compose down` right away.
- **Idle shutdown** — every 5 minutes the manager takes down any stack nobody has
  opened for `IDLE_HOURS` (6 by default). Opening the card starts it again.
- **Icons** — click a card's icon to swap it for another one from the preset set.
- A card with no `compose` folder is a plain link, exactly like the old dashboard.

## Adding apps

Two ways, both write to the same file:

- **In the UI** — `+ Add app`, give it a name, compose folder, address and port.
  Selecting a compose folder pre-fills the port from its first published
  `ports:` entry. The `+ LAN` / `+ VPN` chip on a card adds another URL to an app
  you already have.
- **By hand** — edit `apps.json` (in Docker: the file in the volume). Changes are
  picked up on the next page load, no restart.

```json
{
  "id": "jellyfin",
  "name": "Jellyfin",
  "description": "Movies, shows and music",
  "icon": "🎬",
  "category": "Media",
  "compose": "jellyfin",
  "urls": {
    "lan": "http://192.168.1.10:8096",
    "vpn": "http://homeserver:8096",
    "wan": "https://media.example.com"
  }
}
```

`networks` at the top of the file defines the switcher in the header. Add or
rename them freely, every app URL keys off those ids.

## How the routing works

Cards never link straight to an app. They open `/go/<id>?net=<network>` in a new
tab and the server 302s to the URL for that network, falling back to the default
network and then to the app's only URL. Switch the header to `VPN` and every card
now points at its Tailscale address.

## Settings

| Env | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | `changeme` | Master password. A banner nags until you change it. |
| `PORT` | `5000` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `SESSION_HOURS` | `720` | How long a login lasts. |
| `SECURE_COOKIE` | `false` | Set `true` when behind an HTTPS reverse proxy. |
| `DATA_DIR` | `./data` | Where `apps.json` and `session.key` live. |
| `APPS_FILE` | — | Use a specific catalog file instead of the one in `DATA_DIR`. |
| `STACKS_DIR` | value of `STACKS_HOST_DIR` in Docker | Path holding every app compose folder. |
| `STACKS_HOST_DIR` | `/home/mohan/REPO` | Host path mounted read-only at `STACKS_DIR`. |
| `IDLE_HOURS` | `6` | Idle time before a stack is taken down. |
| `START_TIMEOUT_SEC` | `120` | How long to wait for an app to answer after `compose up`. |

## Security notes

The password is hashed with scrypt at boot and compared in constant time, the
session is an HMAC-signed cookie (HttpOnly, SameSite=Lax) and logins are limited
to 5 attempts per 10 minutes per IP. That is enough for a LAN or a Tailnet. If
you expose this to the internet, put it behind HTTPS and set `SECURE_COOKIE=true`.

## Tests

```bash
npm test
```

Unit tests cover the auth primitives, catalog rules and the stack manager
(start, dedupe, timeout, stop, idle sweep) against a fake docker runner;
`test/server.test.js`
boots the real server on a temp data directory and walks the whole flow (login,
routing, add, persist, delete, logout).

CI runs on every pull request and every push to `main` or `master`:

- **Tests** on Node 20 and 22.
- **Docker image** — builds it, starts it on port 5000 as the non-root `node`
  user, checks the API is closed to anonymous callers, logs in, follows a `/go`
  redirect, adds a card, restarts the container and confirms the card is still
  there, then waits for the container healthcheck to report healthy.
