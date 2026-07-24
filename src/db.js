const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'groupbot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,              -- LINE groupId หรือ roomId
  name TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1,         -- 0 = บอทออกจากกลุ่ม/โดนเตะแล้ว หยุดสรุป
  summary_on INTEGER DEFAULT 1,     -- สรุปอัตโนมัติรายวัน เปิด/ปิด
  summary_hour INTEGER DEFAULT 20   -- ชั่วโมงส่งสรุปรายวัน (เวลาไทย 0-23)
);
CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  user_id TEXT,                     -- null ได้ ถ้าคนส่งไม่ได้ยินยอมเปิดเผยตัวกับบอท
  line_msg_id TEXT,                 -- ไว้จับคู่ตอน unsend แล้วลบ log ตาม
  type TEXT NOT NULL DEFAULT 'text',-- text | image | sticker | video | audio | file | location
  text TEXT,                        -- ข้อความ หรือ placeholder เช่น [รูป]
  ts TEXT DEFAULT (datetime('now')) -- UTC — แปลง +7 ตอน query รายวัน
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_lineid ON messages(line_msg_id);
CREATE TABLE IF NOT EXISTS extracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  message_id INTEGER,               -- อ้างกลับ messages.id
  kind TEXT NOT NULL,               -- 'money' = จับยอดเงินจากข้อความ
  value TEXT,                       -- เช่น "1,500 บาท"
  ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_extracts_group ON extracts(group_id, id);
CREATE TABLE IF NOT EXISTS pushes (
  month TEXT PRIMARY KEY,           -- YYYY-MM (เวลาไทย)
  count INTEGER DEFAULT 0           -- ตัวนับ push เทียบโควต้าฟรี 300/เดือน
);
`);

// migration: v1 (2026-07-24) ย้ายสรุปรายวัน 21:00 → 20:00 (user เคาะ) — DB เก่า schema default ยังเป็น 21
const ver = db.pragma('user_version', { simple: true });
if (ver < 1) {
  db.exec(`UPDATE groups SET summary_hour = 20 WHERE summary_hour = 21`);
  db.pragma('user_version = 1');
}

// ---------- groups ----------
function ensureGroup(id) {
  // ระบุ summary_hour ตรงๆ กัน default เก่า (21) ในไฟล์ DB ที่สร้างก่อน migration
  db.prepare(`INSERT INTO groups (id, summary_hour) VALUES (?, 20) ON CONFLICT(id) DO UPDATE SET active = 1`).run(id);
}
function setGroupName(id, name) {
  db.prepare(`UPDATE groups SET name = ? WHERE id = ?`).run(name, id);
}
function deactivateGroup(id) {
  db.prepare(`UPDATE groups SET active = 0 WHERE id = ?`).run(id);
}
function getGroup(id) {
  return db.prepare(`SELECT * FROM groups WHERE id = ?`).get(id);
}
function setSummaryOn(id, on) {
  db.prepare(`UPDATE groups SET summary_on = ? WHERE id = ?`).run(on ? 1 : 0, id);
}
function setSummaryHour(id, hour) {
  db.prepare(`UPDATE groups SET summary_hour = ? WHERE id = ?`).run(hour, id);
}
// กลุ่มที่ต้องส่งสรุปในชั่วโมงนี้ (เวลาไทย)
function groupsDueForSummary(hour) {
  return db
    .prepare(`SELECT * FROM groups WHERE active = 1 AND summary_on = 1 AND summary_hour = ?`)
    .all(hour);
}

// ---------- members ----------
function upsertMember(groupId, userId, displayName) {
  db.prepare(
    `INSERT INTO members (group_id, user_id, display_name) VALUES (?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`,
  ).run(groupId, userId, displayName);
}
function memberName(groupId, userId) {
  if (!userId) return 'ไม่ทราบชื่อ';
  const row = db
    .prepare(`SELECT display_name FROM members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
  return row?.display_name || 'ไม่ทราบชื่อ';
}

// ---------- messages ----------
function logMessage(groupId, userId, lineMsgId, type, text) {
  const info = db
    .prepare(`INSERT INTO messages (group_id, user_id, line_msg_id, type, text) VALUES (?, ?, ?, ?, ?)`)
    .run(groupId, userId, lineMsgId, type, text);
  return info.lastInsertRowid;
}
// อัพเดทข้อความหลัง AI อ่านรูป/เสียง/ไฟล์เสร็จ (แทน placeholder)
function updateMessageText(id, text) {
  db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
}
// คนกด unsend → ลบ log ตาม (เคารพเจตนาคนลบ)
function deleteByLineMsgId(lineMsgId) {
  const row = db.prepare(`SELECT id FROM messages WHERE line_msg_id = ?`).get(lineMsgId);
  if (!row) return false;
  db.prepare(`DELETE FROM extracts WHERE message_id = ?`).run(row.id);
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(row.id);
  return true;
}
// ข้อความของวันหนึ่งวัน (dateStr = YYYY-MM-DD เวลาไทย)
function messagesOfDay(groupId, dateStr) {
  return db
    .prepare(
      `SELECT m.*, COALESCE(mb.display_name, 'ไม่ทราบชื่อ') name
       FROM messages m LEFT JOIN members mb ON mb.group_id = m.group_id AND mb.user_id = m.user_id
       WHERE m.group_id = ? AND date(m.ts, '+7 hours') = ? ORDER BY m.id`,
    )
    .all(groupId, dateStr);
}
// ข้อความล่าสุด N รายการ (ไว้เป็นบริบทตอบคำถาม)
function recentMessages(groupId, limit = 300) {
  return db
    .prepare(
      `SELECT * FROM (
        SELECT m.*, COALESCE(mb.display_name, 'ไม่ทราบชื่อ') name
        FROM messages m LEFT JOIN members mb ON mb.group_id = m.group_id AND mb.user_id = m.user_id
        WHERE m.group_id = ? ORDER BY m.id DESC LIMIT ?
      ) ORDER BY id`,
    )
    .all(groupId, limit);
}
function searchMessages(groupId, term, limit = 10) {
  return db
    .prepare(
      `SELECT m.*, COALESCE(mb.display_name, 'ไม่ทราบชื่อ') name
       FROM messages m LEFT JOIN members mb ON mb.group_id = m.group_id AND mb.user_id = m.user_id
       WHERE m.group_id = ? AND m.text LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(groupId, `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`, limit);
}

// ---------- extracts ----------
function logExtract(groupId, messageId, kind, value) {
  db.prepare(`INSERT INTO extracts (group_id, message_id, kind, value) VALUES (?, ?, ?, ?)`).run(
    groupId,
    messageId,
    kind,
    value,
  );
}
function extractsOfDay(groupId, dateStr) {
  return db
    .prepare(
      `SELECT e.*, COALESCE(mb.display_name, 'ไม่ทราบชื่อ') name
       FROM extracts e
       LEFT JOIN messages m ON m.id = e.message_id
       LEFT JOIN members mb ON mb.group_id = e.group_id AND mb.user_id = m.user_id
       WHERE e.group_id = ? AND date(e.ts, '+7 hours') = ? ORDER BY e.id`,
    )
    .all(groupId, dateStr);
}

// ---------- push counter (โควต้าฟรี 300/เดือน) ----------
function countPush(month, n = 1) {
  db.prepare(
    `INSERT INTO pushes (month, count) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET count = count + ?`,
  ).run(month, n, n);
}
function pushCount(month) {
  return db.prepare(`SELECT count FROM pushes WHERE month = ?`).get(month)?.count || 0;
}

module.exports = {
  db,
  ensureGroup,
  setGroupName,
  deactivateGroup,
  getGroup,
  setSummaryOn,
  setSummaryHour,
  groupsDueForSummary,
  upsertMember,
  memberName,
  logMessage,
  updateMessageText,
  deleteByLineMsgId,
  messagesOfDay,
  recentMessages,
  searchMessages,
  logExtract,
  extractsOfDay,
  countPush,
  pushCount,
};
