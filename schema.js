// Node 版（db.js）與 Cloudflare Worker 版（worker.js）共用的 schema 與預設清單。
// 每個 statement 獨立一條，方便 D1 用 batch 執行。

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT DEFAULT '中秋烤肉',
    date TEXT DEFAULT '',
    start_time TEXT DEFAULT '17:00',
    end_time TEXT DEFAULT '21:00',
    venue_id INTEGER,
    table_seats INTEGER DEFAULT 10,
    grills INTEGER DEFAULT 2,
    grill_label TEXT DEFAULT '烤肉架',
    grill_capacity INTEGER DEFAULT 6,
    notes TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS venues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'maybe',
    arrive TEXT DEFAULT '',
    leave TEXT DEFAULT '',
    venue_vote INTEGER,
    note TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    need REAL DEFAULT 1,
    unit TEXT DEFAULT '',
    note TEXT DEFAULT '',
    sort INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    qty REAL DEFAULT 1,
    note TEXT DEFAULT ''
  )`,
];

// 既有資料庫補欄位用。每條都各自 try/catch 執行（欄位已存在會報錯，忽略即可）。
export const MIGRATIONS = [
  "ALTER TABLE event ADD COLUMN grill_label TEXT DEFAULT '烤肉架'",
  'ALTER TABLE event ADD COLUMN grill_capacity INTEGER DEFAULT 6',
];

// 預設建議清單（約 12 人份），大家可以自行增刪修改。
// [分類, 名稱, 需要量, 單位, 場地自帶量]
export const SEED_ITEMS = [
  ['tool', '烤肉架', 2, '台', 2],
  ['tool', '大木桌', 1, '張', 1],
  ['tool', '木炭', 3, '包', 0],
  ['tool', '火種', 2, '包', 0],
  ['tool', '打火機／噴槍', 1, '個', 0],
  ['tool', '烤肉夾', 4, '支', 0],
  ['tool', '烤肉刷', 2, '支', 0],
  ['tool', '烤肉網', 2, '片', 0],
  ['tool', '鋁箔紙', 1, '捲', 0],
  ['tool', '刀＋砧板', 1, '組', 0],
  ['tool', '垃圾袋', 1, '包', 0],
  ['tool', '冰桶', 1, '個', 0],
  ['tool', '冰塊', 2, '袋', 0],
  ['tool', '隔熱手套', 1, '雙', 0],
  ['tool', '濕紙巾', 2, '包', 0],
  ['tool', '防蚊液', 1, '瓶', 0],
  ['tableware', '免洗盤', 30, '個', 0],
  ['tableware', '免洗筷', 30, '雙', 0],
  ['tableware', '杯子', 30, '個', 0],
  ['tableware', '紙巾', 2, '包', 0],
  ['seasoning', '烤肉醬', 2, '瓶', 0],
  ['seasoning', '鹽', 1, '罐', 0],
  ['seasoning', '黑胡椒', 1, '罐', 0],
  ['seasoning', '食用油', 1, '瓶', 0],
  ['seasoning', '蒜頭／奶油', 1, '份', 0],
  ['food', '五花肉', 3, '盒', 0],
  ['food', '雞腿肉', 2, '盒', 0],
  ['food', '香腸', 2, '包', 0],
  ['food', '甜不辣', 2, '包', 0],
  ['food', '米血', 1, '包', 0],
  ['food', '玉米', 6, '根', 0],
  ['food', '青椒', 4, '個', 0],
  ['food', '香菇', 2, '盒', 0],
  ['food', '吐司', 2, '條', 0],
  ['food', '飲料', 12, '瓶', 0],
  ['food', '啤酒', 1, '箱', 0],
  ['food', '月餅', 1, '盒', 0],
  ['food', '柚子', 4, '顆', 0],
];

// 兩版共用的 API 欄位白名單
export const TABLES = {
  venues: ['name', 'note'],
  people: ['name', 'status', 'arrive', 'leave', 'venue_vote', 'note'],
  items: ['category', 'name', 'need', 'unit', 'note', 'sort'],
  contributions: ['item_id', 'person_id', 'qty', 'note'],
};
export const EVENT_COLS = ['title', 'date', 'start_time', 'end_time', 'venue_id', 'table_seats', 'grills', 'grill_label', 'grill_capacity', 'notes'];

// SQLite/D1 只接受 null/number/string；把 undefined、''(數字欄位)、boolean 正規化
export function clean(obj, cols) {
  const out = {};
  for (const c of cols) {
    if (!(c in obj)) continue;
    let v = obj[c];
    if (v === undefined || (v === '' && /(_id|_vote|^need$|^qty$|seats|^grills$|capacity|^sort$)/.test(c))) v = null;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    out[c] = v;
  }
  return out;
}
