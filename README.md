# Home Dashboard

[![CI](https://github.com/MohanTn/home-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/home-dashboard/actions/workflows/ci.yml)

One password-gated page that lists every app on your home server, and routes each
card to the right URL for wherever you are (LAN, VPN, public domain).

No dependencies, no build step, no database. Node 20+ only.

## Run it

```bash
sudo DASHBOARD_PASSWORD='pick-something-long' npm start
# http://localhost
```

Port 5000 is the default, which needs no root on Linux. Pick another port with
`PORT=8787 npm start`.

## Run it in Docker

```bash
docker compose up -d --build
```

Edit `DASHBOARD_PASSWORD` in `docker-compose.yml` before the first start. The
`dashboard-data` volume holds `apps.json` and the session key, so cards you add
in the UI survive restarts and rebuilds.

Put your other containers on the same `homelab` network and their container
names work as hostnames in card URLs, e.g. `http://jellyfin:8096`.

## Adding apps

Two ways, both write to the same file:

- **In the UI** — `+ Add app`, give it a name and a URL. `192.168.1.10:8989`
  works, the scheme is filled in for you. The `+ LAN` / `+ VPN` chip on a card
  adds another URL to an app you already have.
- **By hand** — edit `apps.json` (in Docker: the file in the volume). Changes are
  picked up on the next page load, no restart.

```json
{
  "id": "jellyfin",
  "name": "Jellyfin",
  "description": "Movies, shows and music",
  "icon": "🎬",
  "category": "Media",
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

## Security notes

The password is hashed with scrypt at boot and compared in constant time, the
session is an HMAC-signed cookie (HttpOnly, SameSite=Lax) and logins are limited
to 5 attempts per 10 minutes per IP. That is enough for a LAN or a Tailnet. If
you expose this to the internet, put it behind HTTPS and set `SECURE_COOKIE=true`.

## Tests

```bash
npm test
```

Unit tests cover the auth primitives and catalog rules; `test/server.test.js`
boots the real server on a temp data directory and walks the whole flow (login,
routing, add, persist, delete, logout).

CI runs on every pull request and every push to `main` or `master`:

- **Tests** on Node 20 and 22.
- **Docker image** — builds it, starts it on port 5000 as the non-root `node`
  user, checks the API is closed to anonymous callers, logs in, follows a `/go`
  redirect, adds a card, restarts the container and confirms the card is still
  there, then waits for the container healthcheck to report healthy.
