// SQLite — เก็บบทสนทนาแชทส่วนตัวของแต่ละคน ไว้ให้บอทจำได้ว่าคุยอะไรกันไปแล้ว
if (process.env.TURSO_DATABASE_URL) {
  module.exports = require('./remote-db').createRemoteDb();
} else {
if (process.env.VERCEL) throw new Error('ตั้ง TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN ก่อนใช้งานบน Vercel');
const Database = require('better-sqlite3');
const path = require('path');

// ชื่อไฟล์ใหม่ chatbot.db (ไม่ใช่ groupbot.db ของบอทกลุ่มรุ่นเก่า — โครงตารางคนละแบบ ใช้ไฟล์เดียวกันไม่ได้)
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'chatbot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- LINE userId
  display_name TEXT,
  first_seen TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,            -- ห้องแชทส่วนตัว = คนที่คุยด้วย
  role TEXT NOT NULL DEFAULT 'user',-- user = คนพิมพ์มา · bot = บอทตอบ
  line_msg_id TEXT,                 -- ไว้จับคู่ตอน unsend แล้วลบตาม
  type TEXT NOT NULL DEFAULT 'text',-- text | image | sticker | video | audio | file | location
  text TEXT,                        -- ข้อความ หรือสิ่งที่ AI อ่านจากไฟล์ เช่น [รูป] สลิปโอน 500 บาท
  ts TEXT DEFAULT (datetime('now')) -- UTC — แปลง +7 ตอน query รายวัน
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_lineid ON messages(line_msg_id);
`);

// ---------- users ----------
function upsertUser(id, displayName) {
  db.prepare(
    `INSERT INTO users (id, display_name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)`,
  ).run(id, displayName || null);
}
function userName(id) {
  return db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(id)?.display_name || '';
}
function knownUser(id) {
  return !!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id);
}

// ---------- messages ----------
function logMessage(userId, role, lineMsgId, type, text) {
  return db
    .prepare(`INSERT INTO messages (user_id, role, line_msg_id, type, text) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, role, lineMsgId || null, type, text).lastInsertRowid;
}
// อัพเดทข้อความหลัง AI อ่านรูป/เสียง/ไฟล์เสร็จ (แทน placeholder)
function updateMessageText(id, text) {
  db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
}
// คนกด unsend → ลบตาม (เคารพเจตนาคนลบ)
function deleteByLineMsgId(lineMsgId) {
  return db.prepare(`DELETE FROM messages WHERE line_msg_id = ?`).run(lineMsgId).changes > 0;
}
// บทสนทนาล่าสุด N ข้อความของคนนี้ เรียงเก่า → ใหม่
function recentMessages(userId, limit = 60) {
  return db
    .prepare(`SELECT * FROM (SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
    .all(userId, limit);
}
// วันนี้ (เวลาไทย) คนนี้พิมพ์มาแล้วกี่ข้อความ — ไว้กันค่า AI บานจากคนพิมพ์รัว
function userMessagesToday(userId) {
  return db
    .prepare(
      `SELECT count(*) c FROM messages
       WHERE user_id = ? AND role = 'user' AND date(ts, '+7 hours') = date('now', '+7 hours')`,
    )
    .get(userId).c;
}

module.exports = {
  db,
  upsertUser,
  userName,
  knownUser,
  logMessage,
  updateMessageText,
  deleteByLineMsgId,
  recentMessages,
  userMessagesToday,
};
}
