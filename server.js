const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_FILE = path.join(DATA_DIR, 'db.json');

const GROUPS = ['trojan', 'vless', 'vmess', 'vless-hu'];

// ---------------- Storage ----------------

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

// ---------------- Helpers ----------------

function hmac(text) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'king-vpn').update(text).digest('hex');
}

// Tokens are signed, so a redeploy never logs users out.
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

function originOf(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function connectionCode(req, token) {
  const b64 = Buffer.from(originOf(req), 'utf8').toString('base64url');
  return `kv1.${b64}.${token}`;
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

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

function isSupportedLink(link) {
  return /^(vless|vmess|trojan|ss):\/\//i.test(link.trim());
}

// ---------------- Built-in Xray (VLESS / VMess / Trojan over WebSocket) ----------------

const XRAY_BIN = process.env.XRAY_BIN || '/usr/local/bin/xray';
const XRAY_ENABLED = process.env.XRAY_AUTO !== '0' && fs.existsSync(XRAY_BIN);
const WS_ROUTES = [
  { path: '/vl', port: 10001, protocol: 'vless' },
  { path: '/vm', port: 10002, protocol: 'vmess' },
  { path: '/tr', port: 10003, protocol: 'trojan' },
];

function stableUuid() {
  const h = hmac('uuid').slice(0, 32).split('');
  h[12] = '4';
  h[16] = '8';
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function stablePassword() {
  return hmac('trojan').slice(0, 24);
}

function startXray() {
  if (!XRAY_ENABLED) {
    console.log('Xray is not installed here, so no built-in servers are created.');
    return;
  }
  const uuid = stableUuid();
  const password = stablePassword();
  const ws = (p) => ({ network: 'ws', wsSettings: { path: p } });
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      { listen: '127.0.0.1', port: 10001, protocol: 'vless', settings: { clients: [{ id: uuid }], decryption: 'none' }, streamSettings: ws('/vl') },
      { listen: '127.0.0.1', port: 10002, protocol: 'vmess', settings: { clients: [{ id: uuid }] }, streamSettings: ws('/vm') },
      { listen: '127.0.0.1', port: 10003, protocol: 'trojan', settings: { clients: [{ password }] }, streamSettings: ws('/tr') },
    ],
    outbounds: [{ protocol: 'freedom' }],
  };
  ensureDir();
  const file = path.join(DATA_DIR, 'xray.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const run = () => {
    const child = spawn(XRAY_BIN, ['run', '-c', file], { stdio: 'inherit' });
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

function builtInLinks(host) {
  const uuid = stableUuid();
  const password = stablePassword();
  const label = regionLabel();
  const common = `security=tls&sni=${host}&fp=chrome&type=ws&host=${host}`;
  const vmess = {
    v: '2', ps: `${label} VMess`, add: host, port: '443', id: uuid, aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host, path: '/vm', tls: 'tls', sni: host,
  };
  return [
    { group: 'vless', name: `${label} VLESS`, link: `vless://${uuid}@${host}:443?encryption=none&${common}&path=%2Fvl#${encodeURIComponent(`${label} VLESS`)}` },
    { group: 'vmess', name: `${label} VMess`, link: `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}` },
    { group: 'trojan', name: `${label} Trojan`, link: `trojan://${password}@${host}:443?${common}&path=%2Ftr#${encodeURIComponent(`${label} Trojan`)}` },
  ];
}

function ensureBuiltIn(req) {
  if (!XRAY_ENABLED) return;
  let host = '';
  try {
    host = new URL(originOf(req)).hostname;
  } catch {
    return;
  }
  if (!host || db.builtInHost === host) return;
  db.servers = db.servers.filter((s) => !s.builtIn);
  builtInLinks(host).forEach((b, i) => {
    db.servers.push({ id: newId(), group: b.group, link: b.link, name: b.name, order: -100 + i, createdAt: Date.now(), builtIn: true });
  });
  db.builtInHost = host;
  saveDb();
}

// ---------------- API ----------------

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
  const servers = [...db.servers]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.createdAt - a.createdAt)
    .map((s) => ({ id: s.id, group: s.group, link: s.link, name: s.name }));
  res.json({ servers });
});

// ---------------- Admin API ----------------

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

// ---------------- Pages ----------------

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
       <p>Press the button to create a token.</p>
       <button onclick="make()">Create a token</button>
       <div id="out"></div>
       <p class="muted">Keep it private: anyone with it can read the server list.</p>
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
       <p>Add a share link to a group.</p>
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

// Railway gives one public port, so WebSocket upgrades are routed to Xray by path.
server.on('upgrade', (req, socket, head) => {
  const route = WS_ROUTES.find((r) => (req.url || '').startsWith(r.path));
  if (!route || !XRAY_ENABLED) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(route.port, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(`${raw}\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`KING VPN panel listening on ${PORT}`);
  console.log(`data file: ${DB_FILE}`);
  if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set — /admin and the admin API are disabled.');
  startXray();
});
