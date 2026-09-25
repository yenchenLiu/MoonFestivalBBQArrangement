/* 中秋烤肉管理 — 前端（vanilla JS，無依賴） */

const CATS = [
  ['tool', '工具', '🔧'],
  ['food', '食材', '🥩'],
  ['seasoning', '調味料', '🧂'],
  ['tableware', '餐具', '🍽️'],
  ['other', '其他', '📦'],
];
const CAT_NAME = Object.fromEntries(CATS.map(([k, v]) => [k, v]));
const STATUS = { going: '會到', maybe: '不確定', no: '不來' };

let S = null; // 伺服器完整狀態
let me = Number(localStorage.getItem('bbq_me')) || null;
let tab = (location.hash.slice(1) || 'overview').split('/')[0];
let itemFilter = 'all';

const app = document.getElementById('app');
const meSelect = document.getElementById('me');

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10);
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};
const fmtHour = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

async function api(method, url, body) {
  const r = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 404 && url === '/state') {
    // cookie 過期或被清掉：整個站對外都是 404，提示用原本的網址重新進入
    app.innerHTML = '<div class="card empty">🔒 連線已過期，請重新點群組裡的網址進入。</div>';
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    toast(data.error || '操作失敗');
    throw new Error(data.error || r.status);
  }
  return data;
}

function isEditing() {
  const a = document.activeElement;
  return a && app.contains(a) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
}

let lastJson = '';
let pendingRender = false; // 有新狀態但因為使用者正在輸入而暫緩重畫
async function load(fromPoll = false) {
  const data = await api('GET', '/state');
  const json = JSON.stringify(data);
  const changed = json !== lastJson;
  lastJson = json;
  S = data;
  if (fromPoll) {
    if (isEditing()) {
      if (changed) pendingRender = true;
      return;
    }
    if (!changed && !pendingRender) return;
  }
  render();
}

function applyState(data) {
  if (data && data.event) {
    const { id, ...state } = data;
    S = state;
    lastJson = JSON.stringify(state);
    render();
  } else {
    load();
  }
}

// ---------- derived ----------
function derive() {
  const ev = S.event;
  const people = S.people;
  const going = people.filter((p) => p.status === 'going');
  const maybe = people.filter((p) => p.status === 'maybe');
  const no = people.filter((p) => p.status === 'no');

  const contribByItem = {};
  for (const c of S.contributions) (contribByItem[c.item_id] ||= []).push(c);

  const items = S.items.map((it) => {
    const cs = contribByItem[it.id] || [];
    const have = cs.reduce((a, c) => a + (Number(c.qty) || 0), 0);
    const need = Number(it.need) || 0;
    const ratio = need > 0 ? Math.min(1, have / need) : have > 0 ? 1 : 0;
    const status = ratio >= 1 ? 'ok' : have > 0 ? 'partial' : 'missing';
    return { ...it, contribs: cs, have, need, ratio, status };
  });

  const cats = CATS.map(([key, name, icon]) => {
    const list = items.filter((i) => i.category === key);
    const done = list.filter((i) => i.status === 'ok').length;
    return { key, name, icon, list, done, total: list.length, pct: list.length ? done / list.length : 1 };
  }).filter((c) => c.total > 0 || c.key !== 'other');

  const totalItems = items.length;
  const doneItems = items.filter((i) => i.status === 'ok').length;

  const venue = S.venues.find((v) => v.id === ev.venue_id) || null;
  const votes = {};
  for (const p of people) if (p.venue_vote) votes[p.venue_vote] = (votes[p.venue_vote] || 0) + 1;

  return { ev, going, maybe, no, items, cats, totalItems, doneItems, venue, votes };
}

function readiness(d) {
  const checks = [];
  const { ev } = d;
  checks.push(ev.date ? { s: 'ok', t: `日期 ${ev.date} ${ev.start_time}–${ev.end_time}` } : { s: 'bad', t: '尚未設定日期' });
  checks.push(d.venue ? { s: 'ok', t: `場地：${d.venue.name}` } : { s: 'bad', t: '尚未選定場地' });

  const n = d.going.length;
  const seats = Number(ev.table_seats) || 0;
  if (n === 0) checks.push({ s: 'warn', t: '還沒有人確定會到' });
  else if (n <= seats) checks.push({ s: 'ok', t: `${n} 人會到，桌子坐得下（${seats} 位）` });
  else checks.push({ s: 'warn', t: `${n} 人會到，超過桌子 ${seats} 位，可能要加椅子／墊子` });

  // 烤肉設備：名稱、數量、每台約供幾人都可在「活動資訊」設定；數量 0 代表不檢查
  const grills = Number(ev.grills) || 0;
  const grillLabel = ev.grill_label || '烤肉架';
  const perGrill = Number(ev.grill_capacity) || 0;
  if (grills > 0 && perGrill > 0) {
    const grillCap = grills * perGrill;
    if (n > grillCap) checks.push({ s: 'warn', t: `${grills} 台${grillLabel}約供 ${grillCap} 人，${n} 人可能要輪流` });
    else checks.push({ s: 'ok', t: `${grills} 台${grillLabel}，${n} 人夠用` });
  }

  for (const c of d.cats) {
    if (c.total === 0) continue;
    const miss = c.total - c.done;
    checks.push(miss === 0 ? { s: 'ok', t: `${c.name}全部備齊` } : { s: miss >= c.total / 2 ? 'bad' : 'warn', t: `${c.name}還缺 ${miss} 項` });
  }

  // 只提示中途加入或提早離開的人；沒填時間視為全程，不顯示
  const start = toMin(ev.start_time);
  const end = toMin(ev.end_time);
  const partial = [];
  for (const p of d.going) {
    const a = toMin(p.arrive);
    const l = toMin(p.leave);
    const bits = [];
    if (a !== null && (start === null || a > start)) bits.push(`${p.arrive} 到`);
    if (l !== null && (end === null || l < end)) bits.push(`${p.leave} 走`);
    if (bits.length) partial.push(`${p.name} ${bits.join('、')}`);
  }
  if (partial.length) checks.push({ s: 'info', t: `中途加入／提早離開：${partial.join('；')}` });

  // 整體分數：物品 70% + 基本設定 30%
  const basics = [!!ev.date, !!d.venue, d.going.length > 0];
  const basicPct = basics.filter(Boolean).length / basics.length;
  const itemPct = d.totalItems ? d.doneItems / d.totalItems : 1;
  const score = Math.round((itemPct * 0.7 + basicPct * 0.3) * 100);
  return { checks, score };
}

// ---------- render ----------
function render() {
  if (!S) return;
  document.getElementById('brand-title').textContent = S.event.title || '中秋烤肉';
  document.title = S.event.title || '中秋烤肉管理';
  renderMe();
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const d = derive();
  let html = '';
  if (tab === 'overview') html = viewOverview(d);
  else if (tab === 'people') html = viewPeople(d);
  else if (tab === 'venue') html = viewVenue(d);
  else if (tab === 'items') html = viewItems(d);

  // 重畫前先記下新增表單裡打了一半的字，畫完放回去，避免輪詢或失焦把草稿洗掉
  const drafts = [];
  app.querySelectorAll('form[data-add]').forEach((f, i) => {
    f.querySelectorAll('input:not([type=hidden]), select').forEach((el) => {
      if (el.value && el.value !== el.defaultValue) drafts.push([f.dataset.add, i, el.name, el.value]);
    });
  });
  app.innerHTML = html;
  pendingRender = false;
  if (drafts.length) {
    const forms = {};
    app.querySelectorAll('form[data-add]').forEach((f, i) => (forms[`${f.dataset.add}#${i}`] = f));
    for (const [add, i, name, value] of drafts) {
      const el = forms[`${add}#${i}`]?.elements[name];
      if (el) el.value = value;
    }
  }
}

function renderMe() {
  const opts = ['<option value="">— 請選擇 —</option>']
    .concat(S.people.map((p) => `<option value="${p.id}" ${p.id === me ? 'selected' : ''}>${esc(p.name)}</option>`))
    .concat(['<option value="new">＋ 新增我的名字</option>']);
  meSelect.innerHTML = opts.join('');
  if (me && !S.people.some((p) => p.id === me)) {
    me = null;
    localStorage.removeItem('bbq_me');
    meSelect.value = '';
  }
}

// ---- 總覽 ----
function viewOverview(d) {
  const { ev } = d;
  const r = readiness(d);
  const circ = 2 * Math.PI * 46;
  const color = r.score >= 80 ? 'var(--ok)' : r.score >= 50 ? 'var(--warn)' : 'var(--bad)';

  const missing = d.items.filter((i) => i.status !== 'ok').sort((a, b) => a.ratio - b.ratio || a.sort - b.sort);

  return `
  <section class="card">
    <h2>${esc(ev.title || '中秋烤肉')} <span class="sub">${ev.date ? `${esc(ev.date)} ${esc(ev.start_time)}–${esc(ev.end_time)}` : '日期未定'}</span></h2>
    <div class="ready">
      <div class="ring">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r="46" fill="none" stroke="#efe7dd" stroke-width="10"/>
          <circle cx="55" cy="55" r="46" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - r.score / 100)}"/>
        </svg>
        <div class="pct">${r.score}%<small>準備度</small></div>
      </div>
      <ul class="checks">${r.checks.map((c) => `<li class="${c.s}">${esc(c.t)}</li>`).join('')}</ul>
    </div>
  </section>

  <div class="grid2">
    <section class="card">
      <h2>出席 <span class="sub">共 ${S.people.length} 人登記</span></h2>
      <div class="tiles">
        <div class="tile ok"><b>${d.going.length}</b><span>會到</span></div>
        <div class="tile warn"><b>${d.maybe.length}</b><span>不確定</span></div>
        <div class="tile"><b>${d.no.length}</b><span>不來</span></div>
      </div>
      <p class="hint" style="margin:10px 0 0">場地：${d.venue ? esc(d.venue.name) : '<span style="color:var(--bad)">未選定</span>'}　·　桌子 ${ev.table_seats} 位${Number(ev.grills) > 0 ? `　·　${esc(ev.grill_label || '烤肉架')} ${ev.grills} 台` : ''}</p>
    </section>

    <section class="card">
      <h2>物品進度 <span class="sub">${d.doneItems}/${d.totalItems} 項備齊</span></h2>
      <div class="catbars">
        ${d.cats.map((c) => `
          <div class="catbar" data-act="goto-cat" data-cat="${c.key}">
            <span>${c.icon} ${c.name}</span>
            <div class="bar ${c.pct >= 1 ? '' : c.pct > 0 ? 'partial' : 'missing'}"><i style="width:${Math.round(c.pct * 100)}%"></i></div>
            <span class="n">${c.done}/${c.total}</span>
          </div>`).join('')}
      </div>
    </section>
  </div>

  <section class="card">
    <h2>時間軸 <span class="sub">每小時在場人數</span></h2>
    ${viewTimeline(d)}
  </section>

  <section class="card">
    <h2>還缺什麼 <span class="sub">${missing.length} 項</span></h2>
    ${missing.length === 0
      ? '<div class="empty">🎉 全部備齊了！</div>'
      : `<ul class="missing-list">${missing.map((i) => `
          <li class="${i.status}"><b>${esc(i.name)}</b> <span class="muted">${CAT_NAME[i.category] || ''}</span>
            還缺 ${fmtNum(Math.max(0, i.need - i.have))} ${esc(i.unit)}${i.have > 0 ? `<span class="muted">（已有 ${fmtNum(i.have)}）</span>` : ''}</li>`).join('')}
        </ul>
        <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="small" data-act="goto" data-tab="items">去認領 →</button></div>`}
  </section>`;
}

function viewTimeline(d) {
  const start = toMin(d.ev.start_time) ?? 17 * 60;
  const end = toMin(d.ev.end_time) ?? 21 * 60;
  if (end <= start) return '<div class="empty">結束時間需晚於開始時間</div>';
  const span = end - start;
  const hours = [];
  for (let t = start; t < end; t += 60) hours.push(t);

  const attendees = [...d.going, ...d.maybe].map((p) => ({
    ...p,
    a: toMin(p.arrive) ?? start,
    l: toMin(p.leave) ?? end,
  }));
  const counts = hours.map((h) => {
    const g = attendees.filter((p) => p.status === 'going' && p.a < h + 60 && p.l > h).length;
    const m = attendees.filter((p) => p.status === 'maybe' && p.a < h + 60 && p.l > h).length;
    return { g, m };
  });
  const max = Math.max(1, ...counts.map((c) => c.g + c.m));

  if (attendees.length === 0) return '<div class="empty">還沒有人登記出席</div>';

  return `
  <div class="tl">
    <div class="tl-hours">
      ${counts.map((c) => `
        <div class="tl-hour">
          <div class="cnt">${c.g}${c.m ? `<span class="muted">+${c.m}</span>` : ''}</div>
          <div class="stack">
            <div class="go" style="height:${(c.g / max) * 100}%"></div>
            <div class="mb" style="height:${(c.m / max) * 100}%"></div>
          </div>
        </div>`).join('')}
    </div>
    <div class="tl-labels">${hours.map((h) => `<span>${fmtHour(h)}</span>`).join('')}</div>
    <div class="gantt">
      ${attendees.map((p) => {
        const a = Math.max(start, Math.min(end, p.a));
        const l = Math.max(a, Math.min(end, p.l));
        const left = ((a - start) / span) * 100;
        const width = ((l - a) / span) * 100;
        return `<div class="grow"><span class="name" title="${esc(p.name)}">${esc(p.name)}</span>
          <div class="track"><div class="seg ${p.status}" style="left:${left}%;width:${width}%" title="${fmtHour(a)}–${fmtHour(l)}"></div></div></div>`;
      }).join('')}
    </div>
    <div class="legend"><span><i style="background:var(--accent)"></i>會到</span><span><i style="background:#f4c4a9"></i>不確定</span></div>
  </div>`;
}

// ---- 人員 ----
function viewPeople(d) {
  const ev = d.ev;
  const rows = S.people.map((p) => `
    <div class="prow ${p.id === me ? 'me' : ''}" data-table="people" data-id="${p.id}">
      <div class="fields">
        <input class="name" data-field="name" value="${esc(p.name)}" placeholder="名字" />
        <select class="status ${p.status}" data-field="status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span class="time-range">
          <input type="time" data-field="arrive" value="${esc(p.arrive)}" placeholder="${esc(ev.start_time)}" title="到達時間，空白＝從頭" />
          –
          <input type="time" data-field="leave" value="${esc(p.leave)}" placeholder="${esc(ev.end_time)}" title="離開時間，空白＝到尾" />
        </span>
        <input class="note" data-field="note" value="${esc(p.note)}" placeholder="備註（例如：會晚到、帶朋友）" />
      </div>
      <div class="row">
        ${p.id !== me ? `<button class="small ghost" data-act="be-me" data-id="${p.id}" title="這是我">我</button>` : '<span class="badge">我</span>'}
        <button class="ghost" data-act="del" data-table="people" data-id="${p.id}" title="刪除">✕</button>
      </div>
    </div>`).join('');

  return `
  <section class="card">
    <h2>人員 <span class="sub">會到 ${d.going.length} · 不確定 ${d.maybe.length} · 不來 ${d.no.length}</span></h2>
    <p class="hint">時間空白代表全程參加（${esc(ev.start_time)}–${esc(ev.end_time)}）。改完會自動儲存。</p>
    <div class="list">${rows || '<div class="empty">還沒有人，先加上你自己吧</div>'}</div>
    <form class="addform" data-add="people">
      <input class="n" name="name" placeholder="新增名字" required />
      <select name="status"><option value="going">會到</option><option value="maybe" selected>不確定</option><option value="no">不來</option></select>
      <button class="primary" type="submit">＋ 新增</button>
    </form>
  </section>`;
}

// ---- 場地 ----
function viewVenue(d) {
  const ev = d.ev;
  const myVote = me ? S.people.find((p) => p.id === me)?.venue_vote : null;
  const venues = S.venues.map((v) => {
    const sel = v.id === ev.venue_id;
    return `
    <div class="venue ${sel ? 'selected' : ''}" data-table="venues" data-id="${v.id}">
      <div class="row">
        <input class="vname" data-field="name" value="${esc(v.name)}" />
        <input class="vnote" data-field="note" value="${esc(v.note)}" placeholder="備註：地址、交通、費用…" />
      </div>
      <div class="row" style="margin-top:8px">
        <span class="votes">👍 ${d.votes[v.id] || 0} 票</span>
        <span class="spacer"></span>
        <button class="small ${myVote === v.id ? 'primary' : ''}" data-act="vote" data-id="${v.id}">${myVote === v.id ? '已投' : '投一票'}</button>
        <button class="small ${sel ? '' : ''}" data-act="select-venue" data-id="${sel ? '' : v.id}">${sel ? '取消選定' : '選定此場地'}</button>
        <button class="ghost" data-act="del" data-table="venues" data-id="${v.id}" title="刪除">✕</button>
      </div>
    </div>`;
  }).join('');

  return `
  <section class="card">
    <h2>活動資訊</h2>
    <div class="eventform" data-table="event" data-id="1">
      <label>活動名稱<input data-field="title" value="${esc(ev.title)}" /></label>
      <label>日期<input type="date" data-field="date" value="${esc(ev.date)}" /></label>
      <label>開始<input type="time" data-field="start_time" value="${esc(ev.start_time)}" /></label>
      <label>結束<input type="time" data-field="end_time" value="${esc(ev.end_time)}" /></label>
      <label>桌子座位<input type="number" min="0" data-field="table_seats" value="${esc(ev.table_seats)}" /></label>
      <label>烤肉設備名稱<input data-field="grill_label" value="${esc(ev.grill_label ?? '烤肉架')}" placeholder="烤肉架／烤肉台／BBQ 板" /></label>
      <label>設備數量（0＝不檢查）<input type="number" min="0" data-field="grills" value="${esc(ev.grills)}" /></label>
      <label>每台約供幾人<input type="number" min="0" data-field="grill_capacity" value="${esc(ev.grill_capacity ?? 6)}" /></label>
      <label style="grid-column:1/-1">備註<input data-field="notes" value="${esc(ev.notes)}" placeholder="集合方式、停車、費用分攤…" /></label>
    </div>
  </section>

  <section class="card">
    <h2>場地候選 <span class="sub">${d.venue ? `已選定：${esc(d.venue.name)}` : '尚未選定'}</span></h2>
    <p class="hint">大家可以投票，最後由主辦人按「選定此場地」。場地自帶的東西已列在物品裡（標示「場地」）。</p>
    <div class="list">${venues || '<div class="empty">還沒有候選場地</div>'}</div>
    <form class="addform" data-add="venues">
      <input class="n" name="name" placeholder="新增場地名稱" required />
      <input class="n" name="note" placeholder="備註（選填）" />
      <button class="primary" type="submit">＋ 新增</button>
    </form>
  </section>`;
}

// ---- 物品 ----
function viewItems(d) {
  const cats = itemFilter === 'all' ? d.cats : d.cats.filter((c) => c.key === itemFilter);
  const allCats = CATS.map(([k, n, ic]) => {
    const c = d.cats.find((x) => x.key === k);
    return { key: k, name: n, icon: ic, done: c?.done || 0, total: c?.total || 0 };
  });
  const showCats = itemFilter === 'all' ? allCats.filter((c) => c.total > 0 || c.key === 'other') : allCats.filter((c) => c.key === itemFilter);

  const personName = (id) => S.people.find((p) => p.id === id)?.name || '？';

  return `
  <div class="chipsbar">
    <button class="chip ${itemFilter === 'all' ? 'active' : ''}" data-act="filter" data-cat="all">全部 ${d.doneItems}/${d.totalItems}</button>
    ${allCats.map((c) => `<button class="chip ${itemFilter === c.key ? 'active' : ''}" data-act="filter" data-cat="${c.key}">${c.icon} ${c.name} ${c.done}/${c.total}</button>`).join('')}
  </div>
  ${!me ? '<p class="hint" style="margin:0 0 10px">💡 先在右上角選「我是誰」，就能按「我帶」認領物品。</p>' : ''}
  ${showCats.map((c) => {
    const list = d.items.filter((i) => i.category === c.key);
    return `
    <section class="card" id="cat-${c.key}">
      <h2>${c.icon} ${c.name} <span class="sub">${c.done}/${c.total} 備齊</span></h2>
      ${list.map((i) => `
        <div class="item ${i.status === 'ok' ? 'done' : ''}" data-table="items" data-id="${i.id}">
          <div>
            <div class="head">
              <input class="iname" data-field="name" value="${esc(i.name)}" />
              <span class="need">需要 <input type="number" min="0" step="0.5" data-field="need" value="${fmtNum(i.need)}" /> <input class="unit" data-field="unit" value="${esc(i.unit)}" placeholder="單位" /></span>
              <span class="st ${i.status}">${i.status === 'ok' ? '✓ 備齊' : i.status === 'partial' ? `還缺 ${fmtNum(i.need - i.have)}` : '尚無人帶'}</span>
            </div>
            <div class="bar ${i.status === 'ok' ? '' : i.status}"><i style="width:${Math.round(i.ratio * 100)}%"></i></div>
            <div class="who">
              ${i.contribs.map((c) => `
                <span class="c ${c.person_id === null ? 'venue' : c.person_id === me ? 'me' : ''}">
                  ${c.person_id === null ? '🏠 場地' : esc(personName(c.person_id))} ×${fmtNum(c.qty)}
                  <button data-act="del" data-table="contributions" data-id="${c.id}" title="移除">✕</button>
                </span>`).join('')}
            </div>
          </div>
          <div class="act">
            <input type="number" min="0.5" step="0.5" value="${i.need - i.have > 0 ? fmtNum(i.need - i.have) : 1}" class="bring-qty" />
            <button class="small primary" data-act="bring" data-id="${i.id}">我帶</button>
            <button class="ghost" data-act="del" data-table="items" data-id="${i.id}" title="刪除項目">✕</button>
          </div>
        </div>`).join('')}
      ${list.length === 0 ? '<div class="empty">尚無項目</div>' : ''}
      <form class="addform" data-add="items">
        <input type="hidden" name="category" value="${c.key}" />
        <input class="n" name="name" placeholder="新增${c.name}" required />
        <input type="number" name="need" min="0" step="0.5" value="1" title="需要量" />
        <input name="unit" placeholder="單位" style="width:4.5em" />
        <button class="primary" type="submit">＋</button>
      </form>
    </section>`;
  }).join('')}`;
}

// ---------- events ----------
function setTab(t) {
  tab = t;
  if (location.hash.slice(1) !== t) history.replaceState(null, '', '#' + t);
  render();
  window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1) || 'overview';
  if (t !== tab) setTab(t);
});

document.getElementById('tabs').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]');
  if (!a) return;
  e.preventDefault();
  setTab(a.dataset.tab);
});

meSelect.addEventListener('change', async () => {
  const v = meSelect.value;
  if (v === 'new') {
    const name = prompt('你的名字？');
    if (!name?.trim()) return renderMe();
    const data = await api('POST', '/people', { name: name.trim(), status: 'going' });
    me = data.id;
    localStorage.setItem('bbq_me', me);
    applyState(data);
    toast(`嗨 ${name.trim()}！`);
    return;
  }
  me = v ? Number(v) : null;
  if (me) localStorage.setItem('bbq_me', me);
  else localStorage.removeItem('bbq_me');
  render();
});

// 欄位變更 → 自動儲存
app.addEventListener('change', async (e) => {
  const input = e.target;
  const field = input.dataset.field;
  if (!field) return;
  const holder = input.closest('[data-table][data-id]');
  if (!holder) return;
  const table = holder.dataset.table;
  const id = holder.dataset.id;
  let value = input.value;
  if (input.type === 'number') value = value === '' ? null : Number(value);
  try {
    const url = table === 'event' ? '/event' : `/${table}/${id}`;
    const data = await api('PUT', url, { [field]: value });
    toast('已儲存');
    if (!isEditing()) applyState(data);
    else {
      S = data;
      lastJson = JSON.stringify(data);
      pendingRender = true;
    }
  } catch {}
});

// 失焦後若有暫緩的新狀態才重畫，並延遲得比「按下→點擊」的間隔久，
// 避免點「＋ 新增」時輸入框先失焦、表單被重畫、點擊落空。
app.addEventListener('focusout', () => {
  if (!pendingRender) return;
  setTimeout(() => {
    if (pendingRender && !isEditing()) render();
  }, 400);
});

// 新增表單
app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-add]');
  if (!form) return;
  e.preventDefault();
  const table = form.dataset.add;
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.name?.trim()) return;
  body.name = body.name.trim();
  if ('need' in body) body.need = Number(body.need) || 0;
  try {
    const data = await api('POST', `/${table}`, body);
    form.reset();
    applyState(data);
    toast('已新增');
  } catch {}
});

// 按鈕動作
app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = Number(btn.dataset.id);
  try {
    if (act === 'goto') return setTab(btn.dataset.tab);
    if (act === 'goto-cat') {
      itemFilter = btn.dataset.cat;
      return setTab('items');
    }
    if (act === 'filter') {
      itemFilter = btn.dataset.cat;
      return render();
    }
    if (act === 'be-me') {
      me = id;
      localStorage.setItem('bbq_me', me);
      return render();
    }
    if (act === 'del') {
      const table = btn.dataset.table;
      const label = { people: '這個人', venues: '這個場地', items: '這個項目', contributions: '這筆認領' }[table];
      if (table !== 'contributions' && !confirm(`確定要刪除${label}？`)) return;
      const data = await api('DELETE', `/${table}/${id}`);
      applyState(data);
      return toast('已刪除');
    }
    if (act === 'vote') {
      if (!me) return toast('請先在右上角選擇你是誰');
      const cur = S.people.find((p) => p.id === me)?.venue_vote;
      const data = await api('PUT', `/people/${me}`, { venue_vote: cur === id ? null : id });
      return applyState(data);
    }
    if (act === 'select-venue') {
      const data = await api('PUT', '/event', { venue_id: btn.dataset.id ? id : null });
      applyState(data);
      return toast(btn.dataset.id ? '已選定場地' : '已取消選定');
    }
    if (act === 'bring') {
      if (!me) return toast('請先在右上角選擇你是誰');
      const qtyInput = btn.parentElement.querySelector('.bring-qty');
      const qty = Number(qtyInput?.value) || 1;
      const existing = S.contributions.find((c) => c.item_id === id && c.person_id === me);
      const data = existing
        ? await api('PUT', `/contributions/${existing.id}`, { qty: Number(existing.qty) + qty })
        : await api('POST', '/contributions', { item_id: id, person_id: me, qty });
      applyState(data);
      return toast(`已認領 ${fmtNum(qty)}`);
    }
  } catch {}
});

// ---------- boot ----------
load().catch((e) => {
  if (e.message === 'unauthorized') return;
  app.innerHTML = `<div class="card empty">⚠️ 伺服器錯誤<br><small class="muted">${esc(e.message || '無法連線到伺服器')}</small></div>`;
});
setInterval(() => {
  if (document.visibilityState === 'visible') load(true).catch(() => {});
}, 6000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load(true).catch(() => {});
});
