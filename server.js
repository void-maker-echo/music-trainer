const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const PORT = Number(process.env.PORT || 8789);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const INVITE_SECRET = process.env.INVITE_SECRET || 'local-dev-invite-secret';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('base64url');
const STATELESS_INVITES = process.env.VERCEL === '1' || process.env.INVITE_MODE === 'stateless';

const sessions = new Map();
let startupInvite = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function normalizeInvite(code) {
  return String(code || '').trim().toUpperCase();
}

function makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function hashInvite(code) {
  return crypto.createHmac('sha256', INVITE_SECRET).update(normalizeInvite(code)).digest('hex');
}

function signValue(value, length = 24) {
  return crypto.createHmac('sha256', INVITE_SECRET).update(value).digest('base64url').slice(0, length);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createStatelessInvite(maxUses = 1) {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const expiry = expiresAt.toString(36).toUpperCase();
  const nonce = crypto.randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
  const uses = Math.max(1, Math.min(Number(maxUses) || 1, 999)).toString(36).toUpperCase();
  const payload = `${expiry}.${nonce}.${uses}`;
  const signature = signValue(payload, 14).toUpperCase();
  return `MT-${expiry}-${nonce}-${uses}-${signature}`;
}

function verifyStatelessInvite(code) {
  const normalized = normalizeInvite(code);
  const parts = normalized.split('-');
  if (parts.length !== 5 || parts[0] !== 'MT') return { ok: false, reason: 'INVALID' };
  const [, expiry, nonce, uses, signature] = parts;
  if (!expiry || !nonce || !uses || !signature) return { ok: false, reason: 'INVALID' };
  const payload = `${expiry}.${nonce}.${uses}`;
  const expected = signValue(payload, 14).toUpperCase();
  if (!timingSafeEqualString(signature, expected)) return { ok: false, reason: 'INVALID' };
  const expiresAt = parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return { ok: false, reason: 'USED' };
  return { ok: true };
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INVITES_FILE)) {
    startupInvite = makeInviteCode();
    writeStore({
      invites: [{
        id: crypto.randomUUID(),
        codeHash: hashInvite(startupInvite),
        active: true,
        maxUses: 1,
        uses: 0,
        createdAt: new Date().toISOString(),
        usedAt: null
      }]
    });
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(INVITES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.invites)) return { invites: [] };
    return parsed;
  } catch (error) {
    return { invites: [] };
  }
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INVITES_FILE, JSON.stringify(store, null, 2));
}

function createInvite(maxUses = 1) {
  if (STATELESS_INVITES) return createStatelessInvite(maxUses);
  const code = makeInviteCode();
  const store = readStore();
  store.invites.unshift({
    id: crypto.randomUUID(),
    codeHash: hashInvite(code),
    active: true,
    maxUses: Math.max(1, Math.min(Number(maxUses) || 1, 999)),
    uses: 0,
    createdAt: new Date().toISOString(),
    usedAt: null
  });
  writeStore(store);
  return code;
}

function verifyInvite(code) {
  const normalized = normalizeInvite(code);
  if (!normalized) return { ok: false, reason: 'EMPTY' };
  if (STATELESS_INVITES) return verifyStatelessInvite(normalized);

  const store = readStore();
  const hash = hashInvite(normalized);
  const invite = store.invites.find(item => item.active && item.codeHash === hash);
  if (!invite) return { ok: false, reason: 'INVALID' };
  if ((invite.uses || 0) >= (invite.maxUses || 1)) return { ok: false, reason: 'USED' };

  invite.uses = (invite.uses || 0) + 1;
  invite.usedAt = new Date().toISOString();
  writeStore(store);
  return { ok: true };
}

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  if (STATELESS_INVITES) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const payload = `${expiresAt.toString(36)}.${token}`;
    return `${payload}.${signValue(payload)}`;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function verifyStatelessSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!timingSafeEqualString(parts[2], signValue(payload))) return false;
  const expiresAt = parseInt(parts[0], 36);
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function isAuthenticated(req) {
  const token = parseCookies(req).mt_session;
  if (!token) return false;
  if (STATELESS_INVITES) return verifyStatelessSession(token);
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location, 'Cache-Control': 'no-store' });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function isAdmin(req, body = {}) {
  return req.headers['x-admin-token'] === ADMIN_TOKEN || body.adminToken === ADMIN_TOKEN;
}

function publicLoginHtml() {
  return path.join(ROOT, 'login.html');
}

function adminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>邀请码管理</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:#eee;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:20px}.panel{width:100%;max-width:440px;background:#16213e;border-radius:14px;padding:24px}h1{font-size:1.2rem;color:#f0c040}input,button{width:100%;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.16);margin-top:10px;font-size:1rem}input{background:rgba(255,255,255,.08);color:#eee;padding:0 12px}button{background:#e94560;color:#fff;font-weight:700;cursor:pointer}.code{margin-top:14px;background:rgba(255,255,255,.08);border-radius:10px;padding:12px;letter-spacing:2px;color:#f0c040;font-weight:700;text-align:center}.hint{font-size:.82rem;color:#aab;line-height:1.6}.list{margin-top:14px;font-size:.8rem;color:#aab;line-height:1.7;white-space:pre-wrap}
</style>
</head>
<body><div class="panel"><h1>邀请码管理</h1><p class="hint">输入服务器管理员口令后生成一次性邀请码。管理员口令由服务器环境变量 ADMIN_TOKEN 设置，本地启动时会打印在终端里。</p><input id="token" type="password" placeholder="管理员口令"><input id="uses" type="number" min="1" max="999" value="1" placeholder="可使用次数"><button id="generate">生成邀请码</button><button id="refresh">查看记录</button><div class="code" id="code">尚未生成</div><div class="list" id="list"></div></div><script>
async function api(path, options){const token=document.getElementById('token').value.trim();const res=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Admin-Token':token,...(options&&options.headers)}});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'请求失败');return data}
document.getElementById('generate').onclick=async()=>{try{const maxUses=Number(document.getElementById('uses').value)||1;const data=await api('/api/admin/invites',{method:'POST',body:JSON.stringify({maxUses})});document.getElementById('code').textContent=data.code;await load()}catch(e){document.getElementById('code').textContent=e.message}};
document.getElementById('refresh').onclick=load;
async function load(){try{const data=await api('/api/admin/invites',{method:'GET'});document.getElementById('list').textContent=data.invites.map(x=>x.createdAt+'  使用 '+x.uses+'/'+x.maxUses+'  '+(x.active?'有效':'停用')).join('\\n')||'暂无记录'}catch(e){document.getElementById('list').textContent=e.message}}
</script></body></html>`;
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(cleanPath).replace(/^([/\\])+/, '');
  const filePath = path.join(ROOT, normalized || 'index.html');
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function serveFile(req, res, filePath, cacheControl = 'no-store') {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl
  };
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = verifyInvite(body.code);
      if (!result.ok) {
        sendJson(res, 401, { ok: false, error: result.reason === 'USED' ? '邀请码已被使用' : '邀请码不正确' });
        return;
      }
      const token = createSession();
      const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('mt_session', token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), secure }) });
      return;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      sendJson(res, 200, { authenticated: isAuthenticated(req) });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req).mt_session;
      if (token) sessions.delete(token);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('mt_session', '', { maxAge: 0 }) });
      return;
    }

    if (pathname === '/api/admin/invites' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isAdmin(req, body)) {
        sendJson(res, 403, { error: '管理员口令不正确' });
        return;
      }
      const code = createInvite(body.maxUses);
      sendJson(res, 200, { code });
      return;
    }

    if (pathname === '/api/admin/invites' && req.method === 'GET') {
      if (!isAdmin(req)) {
        sendJson(res, 403, { error: '管理员口令不正确' });
        return;
      }
      if (STATELESS_INVITES) {
        sendJson(res, 200, { invites: [], note: 'Vercel 部署使用无存储邀请码模式，不保存生成记录。' });
        return;
      }
      const store = readStore();
      sendJson(res, 200, {
        invites: store.invites.map(item => ({
          id: item.id,
          active: item.active,
          maxUses: item.maxUses,
          uses: item.uses,
          createdAt: item.createdAt,
          usedAt: item.usedAt
        }))
      });
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (error) {
    sendJson(res, 500, { error: '服务器处理失败' });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  if (pathname === '/favicon.ico') {
    send(res, 204, '', { 'Cache-Control': 'public, max-age=86400' });
    return;
  }

  if (pathname === '/admin') {
    send(res, 200, adminHtml(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return;
  }

  if (pathname === '/login.html' || pathname === '/login') {
    if (isAuthenticated(req)) {
      redirect(res, '/');
      return;
    }
    serveFile(req, res, publicLoginHtml(), 'no-store');
    return;
  }

  if (!isAuthenticated(req)) {
    redirect(res, '/login.html');
    return;
  }

  const filePath = safeStaticPath(pathname);
  if (!filePath) {
    send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  serveFile(req, res, filePath, 'no-store');
}

if (!STATELESS_INVITES) ensureStore();
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => send(res, 500, 'Internal server error', { 'Content-Type': 'text/plain; charset=utf-8' }));
});

if (require.main === module) server.listen(PORT, () => {
  console.log(`音感训练营已启动: http://localhost:${PORT}`);
  console.log(`管理员页面: http://localhost:${PORT}/admin`);
  if (!process.env.ADMIN_TOKEN) console.log(`本次本地管理员口令: ${ADMIN_TOKEN}`);
  if (!process.env.INVITE_SECRET) console.log('提示: 正式部署请设置 INVITE_SECRET 环境变量。');
  if (startupInvite) console.log(`初始一次性邀请码: ${startupInvite}`);
});

module.exports = server;
