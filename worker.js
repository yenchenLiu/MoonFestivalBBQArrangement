/* Cloudflare Worker 版：D1 當資料庫、Workers Static Assets 提供前端。
   路由與存取控制邏輯與 server.js 相同，前端完全共用。 */
import { SCHEMA_STATEMENTS, MIGRATIONS, SEED_ITEMS, TABLES, EVENT_COLS, clean } from './schema.js';

const COOKIE_NAME = 'bbq_session';
const COOKIE_DAYS = 30;

// ---------- 存取控制 ----------
let tokenCache = null; // 每個 isolate 算一次即可
async function sessionToken(code) {
  if (tokenCache) return tokenCache;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('bbq-session-v1'));
  tokenCache = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return tokenCache;
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function extractCode(url) {
  const q = url.searchParams.get('code');
  if (q) return q;
  const m = /^\/code=(.+)$/.exec(decodeURIComponent(url.pathname));
  return m ? m[1] : null;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

// ---------- D1：建表 + 預設清單（每個 isolate 只跑一次） ----------
let ready = null;
function ensureReady(db) {
  return (ready ||= (async () => {
    await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
    for (const sql of MIGRATIONS) {
      try { await db.prepare(sql).run(); } catch { /* 欄位已存在 */ }
    }
    // INSERT OR IGNORE：多個 isolate 同時冷啟動時，只有真正插入成功的那一個負責塞預設清單
    const r = await db.prepare('INSERT OR IGNORE INTO event (id) VALUES (1)').run();
    if (r.meta.changes === 1) {
      const stmts = [];
      SEED_ITEMS.forEach(([cat, name, need, unit, byVenue], i) => {
        const id = i + 1;
        stmts.push(db.prepare('INSERT INTO items (id, category, name, need, unit, sort) VALUES (?, ?, ?, ?, ?, ?)').bind(id, cat, name, need, unit, i));
        if (byVenue > 0) {
          stmts.push(db.prepare('INSERT INTO contributions (item_id, person_id, qty, note) VALUES (?, NULL, ?, ?)').bind(id, byVenue, '場地自帶'));
        }
      });
      await db.batch(stmts);
    }
  })().catch((e) => {
    ready = null;
    throw e;
  }));
}

// ---------- 資料存取 ----------
async function getState(db) {
  const [ev, venues, people, items, contributions] = await db.batch([
    db.prepare('SELECT * FROM event WHERE id = 1'),
    db.prepare('SELECT * FROM venues ORDER BY id'),
    db.prepare('SELECT * FROM people ORDER BY id'),
    db.prepare('SELECT * FROM items ORDER BY sort, id'),
    db.prepare('SELECT * FROM contributions ORDER BY id'),
  ]);
  return {
    event: ev.results[0],
    venues: venues.results,
    people: people.results,
    items: items.results,
    contributions: contributions.results,
  };
}

async function insert(db, table, data) {
  const cols = Object.keys(data);
  if (!cols.length) throw new Error('no data');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const r = await db.prepare(sql).bind(...cols.map((c) => data[c])).run();
  return r.meta.last_row_id;
}

async function update(db, table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`;
  await db.prepare(sql).bind(...cols.map((c) => data[c]), id).run();
}

async function remove(db, table, id) {
  // 明確刪掉關聯資料，不依賴 D1 的 foreign key 設定
  const stmts = [];
  if (table === 'items') stmts.push(db.prepare('DELETE FROM contributions WHERE item_id = ?').bind(id));
  if (table === 'people') stmts.push(db.prepare('DELETE FROM contributions WHERE person_id = ?').bind(id));
  if (table === 'venues') {
    stmts.push(db.prepare('UPDATE event SET venue_id = NULL WHERE venue_id = ?').bind(id));
    stmts.push(db.prepare('UPDATE people SET venue_vote = NULL WHERE venue_vote = ?').bind(id));
  }
  stmts.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id));
  await db.batch(stmts);
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid json');
  }
}

// ---------- API ----------
async function handleApi(request, db, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, idStr] = parts;
  const id = idStr ? Number(idStr) : null;
  const method = request.method;

  if (resource === 'state' && method === 'GET') return json(await getState(db));

  if (resource === 'event') {
    if (method === 'GET') return json((await getState(db)).event);
    if (method === 'PUT' || method === 'PATCH') {
      const body = clean(await readBody(request), EVENT_COLS);
      await update(db, 'event', 1, body);
      return json(await getState(db));
    }
  }

  const cols = TABLES[resource];
  if (!cols) return json({ error: 'not found' }, 404);

  if (method === 'GET') return json((await getState(db))[resource]);

  if (method === 'POST') {
    const body = clean(await readBody(request), cols);
    if ((resource === 'people' || resource === 'venues' || resource === 'items') && !body.name?.trim()) {
      return json({ error: '名稱不能空白' }, 400);
    }
    if (resource === 'items' && !body.category) body.category = 'other';
    if (resource === 'contributions' && !body.item_id) return json({ error: 'item_id required' }, 400);
    const newId = await insert(db, resource, body);
    return json({ id: newId, ...(await getState(db)) }, 201);
  }

  if (!id) return json({ error: 'id required' }, 400);

  if (method === 'PUT' || method === 'PATCH') {
    const body = clean(await readBody(request), cols);
    if ('name' in body && !String(body.name ?? '').trim()) return json({ error: '名稱不能空白' }, 400);
    await update(db, resource, id, body);
    return json(await getState(db));
  }

  if (method === 'DELETE') {
    await remove(db, resource, id);
    return json(await getState(db));
  }

  return json({ error: 'method not allowed' }, 405);
}

// ---------- 入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accessCode = (env.ACCESS_CODE || '').trim();
    if (!accessCode) {
      return new Response('ACCESS_CODE 尚未設定：請執行 wrangler secret put ACCESS_CODE', { status: 500 });
    }
    const token = await sessionToken(accessCode);

    // 1) 帶 code 進來：正確就發 cookie 並導回首頁，錯誤一律 404
    const code = extractCode(url);
    if (code !== null) {
      if (!safeEqual(code, accessCode)) return notFound();
      const attrs = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_DAYS * 24 * 3600}`];
      if (url.protocol === 'https:') attrs.push('Secure');
      return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': attrs.join('; ') } });
    }

    // 2) 沒有有效 cookie：一律 404
    const given = parseCookies(request)[COOKIE_NAME];
    if (!given || !safeEqual(given, token)) return notFound();

    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) {
        return json({ error: 'D1 binding「DB」未設定：請到 Worker 的 Settings → Bindings 加上 D1 Database，Variable name 填 DB；或在 wrangler.toml 填入 database_id 後重新 deploy' }, 500);
      }
      try {
        await ensureReady(env.DB);
        return await handleApi(request, env.DB, url);
      } catch (e) {
        console.error(e);
        return json({ error: e.message || 'server error' }, 500);
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    return env.ASSETS.fetch(request);
  },
};
