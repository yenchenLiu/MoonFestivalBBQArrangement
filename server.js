import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { TABLES, EVENT_COLS, clean } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'bbq.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 最低限度的存取控制 ----------
// 進入 /?code=XXX（或 /code=XXX）正確 → 發 cookie；其他沒 cookie 的請求一律 404。
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
if (!ACCESS_CODE) {
  console.error('❌ 請設定環境變數 ACCESS_CODE，例如：');
  console.error('   ACCESS_CODE=20260926-lets-have-a-bbq node server.js');
  process.exit(1);
}
const COOKIE_NAME = 'bbq_session';
const COOKIE_DAYS = 30;
// cookie 值由 code 推導（HMAC），伺服器重啟後仍有效，且不會直接暴露 code
const SESSION_TOKEN = crypto.createHmac('sha256', ACCESS_CODE).update('bbq-session-v1').digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const c = parseCookies(req)[COOKIE_NAME];
  return !!c && safeEqual(c, SESSION_TOKEN);
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true;
}

// 從 ?code=XXX 或路徑 /code=XXX 取出 code
function extractCode(url) {
  const q = url.searchParams.get('code');
  if (q) return q;
  const m = /^\/code=(.+)$/.exec(decodeURIComponent(url.pathname));
  return m ? m[1] : null;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const db = openDb(DB_FILE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------- helpers ----------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function getState() {
  return {
    event: db.prepare('SELECT * FROM event WHERE id = 1').get(),
    venues: db.prepare('SELECT * FROM venues ORDER BY id').all(),
    people: db.prepare('SELECT * FROM people ORDER BY id').all(),
    items: db.prepare('SELECT * FROM items ORDER BY sort, id').all(),
    contributions: db.prepare('SELECT * FROM contributions ORDER BY id').all(),
  };
}

function insert(table, data) {
  const cols = Object.keys(data);
  if (!cols.length) throw new Error('no data');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...cols.map((c) => data[c])).lastInsertRowid;
}

function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`;
  db.prepare(sql).run(...cols.map((c) => data[c]), id);
}

function remove(table, id) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, idStr] = parts;
  const id = idStr ? Number(idStr) : null;
  const method = req.method;

  if (resource === 'state' && method === 'GET') return sendJson(res, 200, getState());

  if (resource === 'event') {
    if (method === 'GET') return sendJson(res, 200, getState().event);
    if (method === 'PUT' || method === 'PATCH') {
      const body = clean(await readBody(req), EVENT_COLS);
      update('event', 1, body);
      return sendJson(res, 200, getState());
    }
  }

  const cols = TABLES[resource];
  if (!cols) return sendJson(res, 404, { error: 'not found' });

  if (method === 'GET') return sendJson(res, 200, getState()[resource]);

  if (method === 'POST') {
    const body = clean(await readBody(req), cols);
    if ((resource === 'people' || resource === 'venues' || resource === 'items') && !body.name?.trim()) {
      return sendJson(res, 400, { error: '名稱不能空白' });
    }
    if (resource === 'items' && !body.category) body.category = 'other';
    if (resource === 'contributions' && !body.item_id) return sendJson(res, 400, { error: 'item_id required' });
    const newId = insert(resource, body);
    return sendJson(res, 201, { id: newId, ...getState() });
  }

  if (!id) return sendJson(res, 400, { error: 'id required' });

  if (method === 'PUT' || method === 'PATCH') {
    const body = clean(await readBody(req), cols);
    if ('name' in body && !String(body.name ?? '').trim()) return sendJson(res, 400, { error: '名稱不能空白' });
    update(resource, id, body);
    return sendJson(res, 200, getState());
  }

  if (method === 'DELETE') {
    remove(resource, id);
    // 若刪掉已選定的場地，清掉活動選定
    if (resource === 'venues') db.prepare('UPDATE event SET venue_id = NULL WHERE venue_id = ?').run(id);
    if (resource === 'venues') db.prepare('UPDATE people SET venue_vote = NULL WHERE venue_vote = ?').run(id);
    return sendJson(res, 200, getState());
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // 1) 帶 code 進來：正確就發 cookie 並導回首頁，錯誤一律 404
    const code = extractCode(url);
    if (code !== null) {
      if (!safeEqual(code, ACCESS_CODE)) return notFound(res);
      const attrs = [
        `${COOKIE_NAME}=${SESSION_TOKEN}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${COOKIE_DAYS * 24 * 3600}`,
      ];
      if (isHttps(req)) attrs.push('Secure');
      res.writeHead(302, { 'Set-Cookie': attrs.join('; '), Location: '/' });
      return res.end();
    }

    // 2) 沒有有效 cookie：一律 404，不透露任何資訊
    if (!isAuthed(req)) return notFound(res);

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: e.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`🌕 中秋烤肉管理  http://localhost:${PORT}`);
  console.log(`   資料庫: ${DB_FILE}`);
});
