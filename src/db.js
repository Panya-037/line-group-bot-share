// ฐานข้อมูล — บทสนทนาแชทส่วนตัวของแต่ละคน + เจ้าของ + ประวัติคำสั่งประจำตัว
//
// ใช้ libSQL (SQLite ที่ต่อได้ทั้งไฟล์ในเครื่องและคลาวด์) ตัวเดียวทุกที่:
//   Railway / เครื่องตัวเอง → ไฟล์ chatbot.db (หรือ DB_PATH=/data/chatbot.db บน volume)
//   Vercel (ไม่มีดิสก์ถาวร)   → Turso: DATABASE_URL=libsql://xxx.turso.io + DATABASE_AUTH_TOKEN
const path = require('path');

function dbUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  return `file:${env.DB_PATH || path.join(__dirname, '..', 'chatbot.db')}`;
}
const URL_ = dbUrl();
const IS_FILE = URL_.startsWith('file:');
// ไฟล์ในเครื่อง = ตัวเต็ม (มีส่วนเนทีฟ) · Turso บนคลาวด์ = ตัว web (JS ล้วน คุยผ่าน HTTP) ไม่ต้องพึ่งไบนารีบน Vercel
const { createClient } = IS_FILE ? require('@libsql/client') : require('@libsql/client/web');
const client = createClient({ url: URL_, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,              -- LINE userId
    display_name TEXT,
    first_seen TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,            -- ห้องแชทส่วนตัว = คนที่คุยด้วย
    role TEXT NOT NULL DEFAULT 'user',-- user = คนพิมพ์มา · bot = บอทตอบ
    lane TEXT NOT NULL DEFAULT 'chat',-- chat = คุยแบบลูกค้า · owner = เจ้าของคุยในโหมดเจ้าของ (แยกความจำกัน)
    line_msg_id TEXT,                 -- ไว้จับคู่ตอน unsend แล้วลบตาม
    type TEXT NOT NULL DEFAULT 'text',-- text | image | sticker | video | audio | file | location
    text TEXT,                        -- ข้อความ หรือสิ่งที่ AI อ่านจากไฟล์ เช่น [รูป] สลิปโอน 500 บาท
    ts TEXT DEFAULT (datetime('now')) -- UTC — แปลง +7 ตอน query รายวัน
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_lineid ON messages(line_msg_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE TABLE IF NOT EXISTS owners (
    user_id TEXT PRIMARY KEY,         -- คนที่พิมพ์ OWNER_CODE ถูก
    mode TEXT NOT NULL DEFAULT 'owner',-- owner = โหมดเจ้าของ · customer = ทดลองคุยแบบลูกค้า
    added_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS brief_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,             -- file = จาก brief.txt / BOT_BRIEF · chat = เจ้าของแก้ผ่านแชท
    text TEXT NOT NULL,
    by_user TEXT,                     -- เจ้าของคนที่แก้ (source = chat)
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS pending_briefs (
    owner_id TEXT PRIMARY KEY,        -- ร่างที่รอเจ้าของพิมพ์ "ยืนยัน"
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
];

// สร้างตารางครั้งเดียวต่อโปรเซส (Vercel = ต่อ cold start) — ทุกคำสั่งรอตัวนี้ก่อน
let ready = null;
function init() {
  ready ??= (async () => {
    if (IS_FILE) await client.execute('PRAGMA journal_mode = WAL');
    await client.batch(SCHEMA, 'write');
    // migration: DB ที่สร้างก่อนมีโหมดเจ้าของ ยังไม่มีคอลัมน์ lane
    const cols = (await client.execute('PRAGMA table_info(messages)')).rows.map((c) => c.name);
    if (!cols.includes('lane')) await client.execute(`ALTER TABLE messages ADD COLUMN lane TEXT NOT NULL DEFAULT 'chat'`);
  })().catch((e) => {
    ready = null; // ล้มแล้วให้ลองใหม่รอบหน้า (เช่น เน็ตไป Turso สะดุดตอนบูต)
    throw e;
  });
  return ready;
}
async function run(sql, args = []) {
  await init();
  return client.execute({ sql, args });
}
const all = async (sql, args) => (await run(sql, args)).rows;
const get = async (sql, args) => (await run(sql, args)).rows[0];

// ---------- users ----------
function upsertUser(id, displayName) {
  return run(
    `INSERT INTO users (id, display_name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)`,
    [id, displayName || null],
  );
}
async function userName(id) {
  return (await get(`SELECT display_name FROM users WHERE id = ?`, [id]))?.display_name || '';
}

// ---------- messages ----------
async function logMessage(userId, role, lineMsgId, type, text, lane = 'chat') {
  const r = await run(`INSERT INTO messages (user_id, role, lane, line_msg_id, type, text) VALUES (?, ?, ?, ?, ?, ?)`, [
    userId,
    role,
    lane,
    lineMsgId || null,
    type,
    text,
  ]);
  return Number(r.lastInsertRowid);
}
// อัพเดทข้อความหลัง AI อ่านรูป/เสียง/ไฟล์เสร็จ (แทน placeholder)
function updateMessageText(id, text) {
  return run(`UPDATE messages SET text = ? WHERE id = ?`, [text, id]);
}
// คนกด unsend → ลบตาม (เคารพเจตนาคนลบ)
async function deleteByLineMsgId(lineMsgId) {
  return (await run(`DELETE FROM messages WHERE line_msg_id = ?`, [lineMsgId])).rowsAffected > 0;
}
// บทสนทนาล่าสุด N ข้อความของคนนี้ในเลนนั้น เรียงเก่า → ใหม่
function recentMessages(userId, limit = 60, lane = 'chat') {
  return all(
    `SELECT * FROM (SELECT * FROM messages WHERE user_id = ? AND lane = ? ORDER BY id DESC LIMIT ?) ORDER BY id`,
    [userId, lane, limit],
  );
}
// วันนี้ (เวลาไทย) คนนี้พิมพ์มาแล้วกี่ข้อความ — ไว้กันค่า AI บานจากคนพิมพ์รัว
async function userMessagesToday(userId) {
  return (
    await get(
      `SELECT count(*) c FROM messages
       WHERE user_id = ? AND role = 'user' AND lane = 'chat' AND date(ts, '+7 hours') = date('now', '+7 hours')`,
      [userId],
    )
  ).c;
}

// ---------- รายงานให้เจ้าของ (ไม่นับเจ้าของเอง) ----------
// ลูกค้าที่คุยตั้งแต่ sinceUtc พร้อมตัวเลขที่คิดจาก SQL ตรงๆ (AI ห้ามนับเอง)
function customersSince(sinceUtc) {
  return all(
    `SELECT m.user_id, COALESCE(u.display_name, '') name,
            count(*) msgs,
            sum(m.role = 'user') user_msgs,
            sum(m.role = 'user' AND m.type IN ('image','audio','video','file')) media,
            sum(m.role = 'user' AND date(m.ts,'+7 hours') = date('now','+7 hours')) today_msgs,
            min(m.ts) first_ts, max(m.ts) last_ts
     FROM messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.lane = 'chat' AND m.ts >= ? AND m.user_id NOT IN (SELECT user_id FROM owners)
     GROUP BY m.user_id
     ORDER BY last_ts DESC`,
    [sinceUtc],
  );
}
function messagesOfUserSince(userId, sinceUtc) {
  return all(`SELECT * FROM messages WHERE user_id = ? AND lane = 'chat' AND ts >= ? ORDER BY id`, [userId, sinceUtc]);
}

// ---------- เจ้าของ ----------
function addOwner(userId) {
  return run(`INSERT INTO owners (user_id) VALUES (?) ON CONFLICT(user_id) DO UPDATE SET mode = 'owner'`, [userId]);
}
async function removeOwner(userId) {
  await run(`DELETE FROM owners WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM pending_briefs WHERE owner_id = ?`, [userId]);
}
async function ownerMode(userId) {
  return (await get(`SELECT mode FROM owners WHERE user_id = ?`, [userId]))?.mode || null; // null = ไม่ใช่เจ้าของ
}
function setOwnerMode(userId, mode) {
  return run(`UPDATE owners SET mode = ? WHERE user_id = ?`, [mode, userId]);
}

// ---------- คำสั่งประจำตัว (อันล่าสุด = ที่ใช้อยู่) ----------
function latestBrief(source = null) {
  return source
    ? get(`SELECT * FROM brief_versions WHERE source = ? ORDER BY id DESC LIMIT 1`, [source])
    : get(`SELECT * FROM brief_versions ORDER BY id DESC LIMIT 1`);
}
async function addBriefVersion(source, text, byUser = null) {
  const r = await run(`INSERT INTO brief_versions (source, text, by_user) VALUES (?, ?, ?)`, [source, text, byUser]);
  return Number(r.lastInsertRowid);
}
// ไฟล์ brief.txt ไม่ตรงกับฉบับไฟล์ล่าสุดที่จำไว้ → บันทึกเป็นฉบับใหม่ (คำสั่งเดียว กันบูตพร้อมกันแล้วซ้ำ)
async function addFileBriefIfChanged(text) {
  const r = await run(
    `INSERT INTO brief_versions (source, text)
     SELECT 'file', ? WHERE COALESCE((SELECT text FROM brief_versions WHERE source = 'file' ORDER BY id DESC LIMIT 1), '') != ?`,
    [text, text],
  );
  return r.rowsAffected > 0;
}
async function countBriefVersions() {
  return (await get(`SELECT count(*) c FROM brief_versions`)).c;
}
// ย้อนกลับ = ทิ้งฉบับล่าสุด (เหลืออย่างน้อย 1 ฉบับ) คืนฉบับที่กลับมาใช้ หรือ null ถ้าย้อนไม่ได้
async function popBriefVersion() {
  const rows = await all(`SELECT id FROM brief_versions ORDER BY id DESC LIMIT 2`);
  if (rows.length < 2) return null;
  await run(`DELETE FROM brief_versions WHERE id = ?`, [rows[0].id]);
  return latestBrief();
}
function setPendingBrief(ownerId, text) {
  return run(
    `INSERT INTO pending_briefs (owner_id, text) VALUES (?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET text = excluded.text, created_at = datetime('now')`,
    [ownerId, text],
  );
}
// ร่างที่ค้างเกิน 24 ชม. ถือว่าหมดอายุ (กันเผลอพิมพ์ "ยืนยัน" ทีหลังแล้วได้ของเก่า)
function getPendingBrief(ownerId) {
  return get(`SELECT * FROM pending_briefs WHERE owner_id = ? AND created_at >= datetime('now', '-1 day')`, [ownerId]);
}
function clearPendingBrief(ownerId) {
  return run(`DELETE FROM pending_briefs WHERE owner_id = ?`, [ownerId]);
}

// ---------- ระบบ ----------
// ไฟล์ฐานข้อมูล (ไว้ดาวน์โหลดสำรอง) — ใช้ Turso จะได้ null (สำรองผ่านหน้าเว็บ Turso แทน)
function dbFile() {
  return IS_FILE ? URL_.slice('file:'.length) : null;
}
async function checkpoint() {
  if (IS_FILE) await run('PRAGMA wal_checkpoint(TRUNCATE)');
}

module.exports = {
  client,
  init,
  run,
  dbUrl,
  dbFile,
  checkpoint,
  IS_FILE,
  upsertUser,
  userName,
  logMessage,
  updateMessageText,
  deleteByLineMsgId,
  recentMessages,
  userMessagesToday,
  customersSince,
  messagesOfUserSince,
  addOwner,
  removeOwner,
  ownerMode,
  setOwnerMode,
  latestBrief,
  addBriefVersion,
  addFileBriefIfChanged,
  countBriefVersions,
  popBriefVersion,
  setPendingBrief,
  getPendingBrief,
  clearPendingBrief,
};
