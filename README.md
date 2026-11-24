# KING VPN — three-page panel

A rewrite of the KING VPN app: the token field, WARP and the scanner are gone, the panel
is three pages, and the token is issued by a small backend that runs on Railway.

> **v1.9.1 — build fix.** `expo-clipboard` was pinned to a version that does not match
> Expo SDK 57 (`npx expo install --check` flagged it), and the GitHub Actions workflow
> could not find `app.json` when the source zip had been extracted. Both are fixed, and
> the workflow now surfaces the real Gradle error instead of swallowing it. See the end of
> `BUILD_GUIDE.md`.

## The three pages

| Page | What is on it |
|------|----------------|
| **1 — Home** | One big **Fastest country** button, and one row of group buttons: **Trojan / VLESS / VMess / VLESS HU**. Nothing else. |
| **2 — Settings** | Channel, owner, black/white theme, language, and the panel token (issued by the panel, not typed). |
| **3 — Panel** | The same panel as page 1 (fastest country + the four group buttons). |

Both page 1 and page 3 render the same component (`src/components/home-panel.tsx`), so
they can never drift apart.

## What was removed

- The Cloudflare token field, the "get a token" flow and the deployment steps.
- WARP (protocol picker, WARP registration, WireGuard probing).
- The IP scanner and the reachability probes.
- The onboarding and permission-gate screens.

The app now opens straight into the three tabs.

## How the token works

The app never asks the user for a token. On first launch it calls the panel's
`POST /api/token`, stores the token on the device, and uses it for every later call. The
Settings page shows the token (masked), can request a fresh one, and links to the panel's
own token page (`/token`).

## The backend (`server/`)

A plain Node/Express service with a JSON file for storage — no database needed.

```
server/
  server.js      the whole API + the /token and /admin pages
  package.json
  railway.json   Railway build/deploy config
  README.md      step-by-step Railway deployment
```

### Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Set the service **Root Directory** to `server`.
4. Add a **Volume** mounted at `/data`.
5. Set variables: `DATA_DIR=/data` and `ADMIN_KEY=<a long random string>`.
6. Open the service URL — `/health` returns `{"ok":true,...}`.

Full details in `server/README.md`.

### Point the app at the panel

Nothing to configure at build time. On first launch the app asks for the panel address
and a token, keeps both on the device, and uses them for every request. The same APK
works for every user, and changing the panel later needs no rebuild — Settings →
"Change address and token".

### Add servers

Open `https://<your-service>.up.railway.app/admin`, paste the admin key, and add a
`vless://`, `vmess://`, `trojan://` or `ss://` link to a group. The **first** server of a
group (lowest `order`) is what "Fastest country" and that group's button connect to.

## Build the app

```bash
npm install
npx tsc --noEmit      # typecheck
npx expo run:android  # or the EAS build in eas.json
```

The VPN itself needs the native module in `modules/king-vpn-tunnel`, so it only works in a
development or release APK — not in Expo Go.
