# KING VPN panel — Railway deployment

This folder is the backend the app talks to. It issues tokens and publishes the server
groups the app shows. It is a plain Node/Express service with a JSON file for storage, so
it deploys to Railway with no database.

## Deploy

1. Push this repository to GitHub (or run `railway up` from this folder).
2. On [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. Set the service's **Root Directory** to `server`.
4. Railway detects Node and runs `npm start` (see `package.json`).
5. Add a **Volume** mounted at `/data` (so tokens and servers survive a redeploy).
6. Set these variables on the service:

   | Variable    | Value                                   |
   |-------------|-----------------------------------------|
   | `DATA_DIR`  | `/data`                                 |
   | `ADMIN_KEY` | a long random string you choose         |

   `PORT` is provided by Railway automatically.

7. Open the service's public URL. `/health` should return `{"ok":true,...}`.

## Use

- **`/token`** — create a token by hand. This is the page the app's
  “Open the token page on the panel” button opens.
- **`/admin`** — add and remove servers. Paste a `vless://`, `vmess://`, `trojan://` or
  `ss://` link, pick its group, and save. The **first** server of a group (lowest `order`)
  is what “Fastest country” and that group's button connect to.
- **`/api/servers`** — what the app reads, with the caller's token in `x-api-token`.

## Point the app at it

Nothing to set at build time. On first launch the app asks for the panel address and a
token, keeps both on the device, and sends the token as `x-api-token` on every request.
The same APK works for every user, and moving the panel to a new domain needs no rebuild.

Create a token on the panel's `/token` page and paste it into the app's setup screen.

## API

| Method | Path                     | Auth        | Purpose                          |
|--------|--------------------------|-------------|----------------------------------|
| GET    | `/health`                | —           | liveness                         |
| POST   | `/api/token`             | —           | issue a token                    |
| GET    | `/api/token/:token`      | —           | is this token valid?             |
| GET    | `/api/servers`           | token       | the server list, best first      |
| GET    | `/api/admin/servers`     | admin key   | full list with ids               |
| POST   | `/api/admin/servers`     | admin key   | add a server                     |
| DELETE | `/api/admin/servers/:id` | admin key   | remove a server                  |

## Built-in server: VLESS + REALITY (TCP)

The panel starts one Xray inbound (VLESS + REALITY, raw TCP) on `XRAY_PORT` (default 8443).
Enable **Settings → Networking → TCP Proxy** on the service with internal port `8443`; the app
does this automatically. The link uses the TCP Proxy's host and port (`TCP_HOST` / `TCP_PORT`,
or Railway's `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT`). Optional: `REALITY_DEST`
(default `www.microsoft.com`). The REALITY keys and UUID are derived from `ADMIN_KEY`.
