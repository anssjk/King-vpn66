/**
 * KING VPN panel — the backend the app talks to.
 *
 * What it does:
 *   POST /api/token            → issues a token (the app never asks the user for one)
 *   GET  /api/token/:token     → { valid: true|false }
 *   GET  /api/servers          → the servers for the caller's token, best first
 *   GET  /token                → a small page where a token can be created by hand
 *   GET  /admin                → a page to add / remove servers (protected by ADMIN_KEY)
 *   GET  /health               → liveness probe for Railway
 *
 * Storage is a JSON file under DATA_DIR (mount a Railway volume there so it survives a
 * redeploy). No database is required, and nothing is invented: the servers the app shows
 * are exactly the links an admin added here.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_FILE = path.join(DATA_DIR, 'db.json');

const GROUPS = ['trojan', 'vless', 'vmess', 'vless-hu'];

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    return { tokens: {}, servers: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      builtInHost: typeof parsed.builtInHost === 'string' ? parsed.builtInHost : '',
    };
  } catch {
    // A corrupt file must not take the panel down; start clean but keep a copy.
    try {
      fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return { tokens: {}, servers: [] };
  }
}

let db = loadDb();

function saveDb() {
  ensureDir();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** HMAC of `text` keyed by ADMIN_KEY, so values derived from it are stable across redeploys. */
function hmac(text) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'king-vpn').update(text).digest('hex');
}

/**
 * Tokens are signed, not just stored: a valid signature is enough. That way a redeploy on
 * Railway (which wipes an un-mounted data folder) never logs every user out.
 */
function newToken() {
  const rand = crypto.randomBytes(24).toString('hex');
  return rand + hmac(`token:${rand}`).slice(0, 16);
}

function isKnownToken(token) {
  if (!token) return false;
  if (db.tokens[token]) return true;
  if (token.length !== 64) return false;
  const rand = token.slice(0, 48);
  return token.slice(48) === hmac(`token:${rand}`).slice(0, 16);
}

/** The panel's public address: PUBLIC_URL if set, otherwise taken from the request. */
function originOf(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** One string holding both the panel address and the token: kv1.<b64url(origin)>.<token> */
function connectionCode(req, token) {
  const b64 = Buffer.from(originOf(req), 'utf8').toString('base64url');
  return `kv1.${b64}.${token}`;
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/** The token from the `x-api-token` header, a bearer header, or a query parameter. */
function tokenFrom(req) {
  const header = req.get('x-api-token');
  if (header) return String(header).trim();
  const auth = req.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (typeof req.query.token === 'string') return req.query.token.trim();
  return '';
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: 'ADMIN_KEY is not set on the panel.' });
  }
  const given = req.get('x-admin-key') || (typeof req.query.key === 'string' ? req.query.key : '');
  if (given !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Wrong admin key.' });
  }
  return next();
}

/** Only these link schemes are accepted, so a typo cannot become a broken row. */
function isSupportedLink(link) {
  return /^(vless|vmess|trojan|ss):\/\//i.test(link.trim());
}

// ---------------------------------------------------------------------------------------
// Built-in Xray server: VLESS + REALITY over raw TCP, published through Railway's TCP Proxy
// ---------------------------------------------------------------------------------------

const XRAY_BIN = process.env.XRAY_BIN || '/usr/local/bin/xray';
const XRAY_ENABLED = process.env.XRAY_AUTO !== '0' && fs.existsSync(XRAY_BIN);
// Must be the same number as the TCP Proxy's internal (application) port.
const XRAY_PORT = Number(process.env.XRAY_PORT || 8443);
const REALITY_DEST = process.env.REALITY_DEST || 'www.microsoft.com';
// Public address of the TCP Proxy. The app sets TCP_HOST / TCP_PORT; Railway also provides
// RAILWAY_TCP_PROXY_DOMAIN / RAILWAY_TCP_PROXY_PORT once the proxy exists.
const TCP_HOST = process.env.TCP_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || '';
const TCP_PORT = process.env.TCP_PORT || process.env.RAILWAY_TCP_PROXY_PORT || '';

function stableUuid() {
  const h = hmac('uuid').slice(0, 32).split('');
  h[12] = '4';
  h[16] = '8';
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A stable x25519 key pair derived from ADMIN_KEY, so a redeploy keeps the same links. */
function realityKeys() {
  const raw = Buffer.from(hmac('reality-key'), 'hex'); // 32 bytes
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return {
    privateKey: raw.toString('base64url'),
    publicKey: spki.subarray(spki.length - 32).toString('base64url'),
  };
}

function shortId() {
  return hmac('reality-sid').slice(0, 16);
}

function startXray() {
  if (!XRAY_ENABLED) {
    console.log('Xray is not installed here, so no built-in server is created.');
    return;
  }
  const config = {
    log: { loglevel: 'warning' },
    // Small buffers and short idle time keep memory and CPU low.
    policy: { levels: { 0: { handshake: 4, connIdle: 300, bufferSize: 4 } } },
    inbounds: [
      {
        listen: '0.0.0.0',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: { clients: [{ id: stableUuid(), flow: 'xtls-rprx-vision' }], decryption: 'none' },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            dest: `${REALITY_DEST}:443`,
            serverNames: [REALITY_DEST],
            privateKey: realityKeys().privateKey,
            shortIds: [shortId()],
          },
        },
      },
    ],
    outbounds: [{ protocol: 'freedom' }],
  };
  ensureDir();
  const file = path.join(DATA_DIR, 'xray.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const run = () => {
    const child = spawn(XRAY_BIN, ['run', '-c', file], { stdio: 'inherit', env: { ...process.env, GOGC: '50' } });
    child.on('exit', (code) => {
      console.warn(`xray exited (${code}); restarting in 2s`);
      setTimeout(run, 2000);
    });
  };
  run();
}

function regionLabel() {
  const r = process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || '';
  if (/europe-west4|drams|amsterdam/i.test(r)) return 'Netherlands';
  if (/^us-/i.test(r)) return 'USA';
  if (/asia-southeast/i.test(r)) return 'Singapore';
  return 'Railway';
}

/** The share link for the built-in server: the TCP Proxy's host and port, REALITY on top. */
function builtInLink() {
  const name = `${regionLabel()} VLESS Reality`;
  const q = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: REALITY_DEST,
    fp: 'chrome',
    pbk: realityKeys().publicKey,
    sid: shortId(),
    type: 'tcp',
  });
  return { name, link: `vless://${stableUuid()}@${TCP_HOST}:${TCP_PORT}?${q.toString()}#${encodeURIComponent(name)}` };
}

/** Make sure the built-in server is in the list and points at the current TCP Proxy. */
function ensureBuiltIn() {
  if (!XRAY_ENABLED || !TCP_HOST || !TCP_PORT) return;
  const key = `${TCP_HOST}:${TCP_PORT}:${REALITY_DEST}`;
  if (db.builtInHost === key) return;
  const b = builtInLink();
  db.servers = db.servers.filter((s) => !s.builtIn);
  db.servers.push({ id: newId(), group: 'vless', link: b.link, name: b.name, order: -100, createdAt: Date.now(), builtIn: true });
  db.builtInHost = key;
  saveDb();
}

// ---------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, servers: db.servers.length, tokens: Object.keys(db.tokens).length });
});

app.post('/api/token', (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : 'app';
  const token = newToken();
  const createdAt = Date.now();
  db.tokens[token] = { label, createdAt };
  ensureBuiltIn(req);
  saveDb();
  res.json({ token, code: connectionCode(req, token), createdAt });
});

app.get('/api/token/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  res.json({ valid: isKnownToken(token) });
});

app.get('/api/servers', (req, res) => {
  const token = tokenFrom(req);
  if (!isKnownToken(token)) {
    return res.status(401).json({ error: 'A valid token is required.' });
  }
  ensureBuiltIn(req);
  // The order is the panel's own: `order` ascending, then newest first. The app treats
  // the first row of a group as that group's fastest server.
  const servers = [...db.servers]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.createdAt - a.createdAt)
    .map((s) => ({ id: s.id, group: s.group, link: s.link, name: s.name }));
  res.json({ servers });
});

// ---------------------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------------------

app.get('/api/admin/servers', requireAdmin, (_req, res) => {
  res.json({ servers: db.servers });
});

app.post('/api/admin/servers', requireAdmin, (req, res) => {
  const group = String(req.body?.group || '').trim();
  const link = String(req.body?.link || '').trim();
  const name = String(req.body?.name || '').trim();
  const order = Number(req.body?.order ?? 0);

  if (!GROUPS.includes(group)) {
    return res.status(400).json({ error: `group must be one of: ${GROUPS.join(', ')}` });
  }
  if (!isSupportedLink(link)) {
    return res.status(400).json({ error: 'link must start with vless://, vmess://, trojan:// or ss://' });
  }

  const server = {
    id: newId(),
    group,
    link,
    name: name || undefined,
    order: Number.isFinite(order) ? order : 0,
    createdAt: Date.now(),
  };
  db.servers.push(server);
  saveDb();
  res.json({ server });
});

app.delete('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const before = db.servers.length;
  db.servers = db.servers.filter((s) => s.id !== req.params.id);
  if (db.servers.length === before) {
    return res.status(404).json({ error: 'No such server.' });
  }
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background:radial-gradient(1200px 600px at 10% -10%,#12305c 0%,#05070f 55%),#05070f;color:#f2f6ff;
    display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:520px;background:rgba(22,29,48,.78);border:1px solid rgba(140,170,230,.18);
    border-radius:22px;padding:28px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
  h1{margin:0 0 6px;font-size:24px;letter-spacing:-.4px}
  p{margin:0 0 18px;color:#a3b1cc;font-size:14px;line-height:1.55}
  button{width:100%;padding:14px;border:0;border-radius:14px;font-size:15px;font-weight:800;color:#04101f;
    background:linear-gradient(135deg,#4da3ff,#a78bfa);cursor:pointer}
  button:active{opacity:.85}
  code{display:block;margin-top:16px;padding:14px;border-radius:12px;background:#0b1020;
    border:1px solid rgba(140,170,230,.18);font-size:13px;word-break:break-all;color:#3dd68c}
  .muted{color:#7e8dab;font-size:12px;margin-top:10px}
  input,select{width:100%;padding:11px 12px;margin-bottom:10px;border-radius:11px;border:1px solid rgba(140,170,230,.22);
    background:#0b1020;color:#f2f6ff;font-size:14px}
  .row{display:flex;gap:8px}
  .row>*{flex:1}
  ul{list-style:none;padding:0;margin:16px 0 0}
  li{display:flex;gap:8px;align-items:center;padding:9px 0;border-top:1px solid rgba(140,170,230,.12);font-size:12.5px}
  li span{flex:1;word-break:break-all;color:#a3b1cc}
  .del{background:#2a1520;color:#ff6b6b;border:1px solid #5a2430;border-radius:9px;padding:6px 10px;
    font-size:11px;font-weight:800;cursor:pointer;width:auto}
</style></head><body><div class="card">${body}</div></body></html>`;

app.get('/', (_req, res) => res.redirect('/token'));

app.get('/token', (_req, res) => {
  res.send(
    page(
      'KING VPN — token',
      `<h1>KING <span style="color:#4da3ff">VPN</span></h1>
       <p>Press the button to create a token. The app asks for one automatically, so you only
       need this page if you want a token by hand.</p>
       <button onclick="make()">Create a token</button>
       <div id="out"></div>
       <p class="muted">Tokens are stored on this panel. Keep one private: anyone with it can
       read the server list.</p>
       <script>
         async function make(){
           const r = await fetch('/api/token',{method:'POST',headers:{'Content-Type':'application/json'},
             body:JSON.stringify({label:'web'})});
           const j = await r.json();
           document.getElementById('out').innerHTML =
             '<p>Connection code (paste this in the app):</p><code>'+j.code+'</code><p class="muted">Created '+new Date(j.createdAt).toLocaleString()+'</p>';
         }
       </script>`,
    ),
  );
});

app.get('/admin', (_req, res) => {
  res.send(
    page(
      'KING VPN — admin',
      `<h1>Servers</h1>
       <p>Add a share link to a group. The first server of a group is the one
       “Fastest country” and that group's button connect to.</p>
       <input id="key" placeholder="Admin key" type="password">
       <select id="group">
         <option value="trojan">Trojan</option>
         <option value="vless">VLESS</option>
         <option value="vmess">VMess</option>
         <option value="vless-hu">VLESS HU</option>
       </select>
       <input id="name" placeholder="Display name (optional)">
       <input id="link" placeholder="vless://… / vmess://… / trojan://… / ss://…">
       <input id="order" placeholder="Order (0 = first)" value="0">
       <button onclick="add()">Add server</button>
       <ul id="list"></ul>
       <script>
         const key = () => document.getElementById('key').value.trim();
         async function load(){
           const r = await fetch('/api/admin/servers',{headers:{'x-admin-key':key()}});
           if(!r.ok){document.getElementById('list').innerHTML='<li>'+((await r.json()).error||'error')+'</li>';return;}
           const j = await r.json();
           document.getElementById('list').innerHTML = j.servers.map(s =>
             '<li><b>'+s.group+'</b><span>'+(s.name? s.name+' — ':'')+s.link+'</span>'+
             '<button class="del" onclick="del(\\''+s.id+'\\')">Delete</button></li>').join('')
             || '<li>No servers yet.</li>';
         }
         async function add(){
           const body={group:document.getElementById('group').value,link:document.getElementById('link').value,
             name:document.getElementById('name').value,order:Number(document.getElementById('order').value||0)};
           const r=await fetch('/api/admin/servers',{method:'POST',
             headers:{'Content-Type':'application/json','x-admin-key':key()},body:JSON.stringify(body)});
           if(!r.ok){alert((await r.json()).error||'error');return;}
           document.getElementById('link').value='';document.getElementById('name').value='';
           load();
         }
         async function del(id){
           await fetch('/api/admin/servers/'+id,{method:'DELETE',headers:{'x-admin-key':key()}});
           load();
         }
         document.getElementById('key').addEventListener('change',load);
       </script>`,
    ),
  );
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`KING VPN panel listening on ${PORT}`);
  console.log(`data file: ${DB_FILE}`);
  if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set — /admin and the admin API are disabled.');
  if (XRAY_ENABLED && (!TCP_HOST || !TCP_PORT)) console.warn('TCP Proxy is not set up yet — no built-in link is published.');
  startXray();
});
