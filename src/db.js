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
  summary_hour INTEGER DEFAULT 20,  -- ชั่วโมงส่งสรุปรายวัน (เวลาไทย 0-23)
  image_reply INTEGER DEFAULT 0     -- ส่งรูปปุ๊บให้บอทตอบสรุปทันที (เปิดรายกลุ่มด้วย !อ่านรูป เปิด)
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
CREATE TABLE IF NOT EXISTS digests (
  group_id TEXT NOT NULL,
  date TEXT NOT NULL,               -- วันไทย YYYY-MM-DD
  last_msg_id INTEGER,              -- ข้อความล่าสุดตอนสรุป — เปลี่ยน = สรุปใหม่
  json TEXT,                        -- {"headline":"","topics":[],"followups":[]}
  computed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, date)
);
CREATE TABLE IF NOT EXISTS work_items (
  group_id TEXT NOT NULL,
  date TEXT NOT NULL,               -- วันไทย YYYY-MM-DD
  last_msg_id INTEGER,              -- ข้อความล่าสุดตอนคำนวณ — เปลี่ยน = ต้องให้ AI อ่านใหม่
  json TEXT,                        -- {"tasks":[],"money":[],"pending":[]}
  computed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, date)
);
`);

// migration: v1 (2026-07-24) ย้ายสรุปรายวัน 21:00 → 20:00 (user เคาะ) — DB เก่า schema default ยังเป็น 21
const ver = db.pragma('user_version', { simple: true });
if (ver < 1) {
  db.exec(`UPDATE groups SET summary_hour = 20 WHERE summary_hour = 21`);
  db.pragma('user_version = 1');
}

// migration: v2 (2026-08-25) เพิ่ม image_reply — DB เก่ายังไม่มีคอลัมน์นี้
if (ver < 2) {
  const cols = db.prepare(`PRAGMA table_info(groups)`).all().map((c) => c.name);
  if (!cols.includes('image_reply')) db.exec(`ALTER TABLE groups ADD COLUMN image_reply INTEGER DEFAULT 0`);
  db.pragma('user_version = 2');
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
function setImageReply(id, on) {
  db.prepare(`UPDATE groups SET image_reply = ? WHERE id = ?`).run(on ? 1 : 0, id);
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

// ---------- งานที่คัดจากแชท (cache ผลของ AI ไว้ ไม่ต้องอ่านซ้ำ) ----------
function getWorkItems(groupId, dateStr) {
  return db.prepare(`SELECT * FROM work_items WHERE group_id = ? AND date = ?`).get(groupId, dateStr);
}
function saveWorkItems(groupId, dateStr, lastMsgId, data) {
  db.prepare(
    `INSERT INTO work_items (group_id, date, last_msg_id, json, computed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(group_id, date) DO UPDATE SET
       last_msg_id = excluded.last_msg_id, json = excluded.json, computed_at = excluded.computed_at`,
  ).run(groupId, dateStr, lastMsgId, JSON.stringify(data));
}
// กลุ่ม+วันที่มีการคุยกันจริงในช่วงที่เลือก (ไว้ไล่คัดงาน) — เรียงวันใหม่ไปเก่า
// ไม่ได้เจาะจงกลุ่ม = เอาเฉพาะกลุ่มที่บอทยังอยู่ (กลุ่มที่ออกมาแล้วไม่มีงานให้ตามต่อ)
function activeGroupDays(from, to, groupId = null) {
  const args = groupId ? [from, to, groupId] : [from, to];
  return db
    .prepare(
      `SELECT m.group_id, date(m.ts,'+7 hours') date, count(*) c, max(m.id) last_msg_id,
              COALESCE(g.name,'(ยังไม่รู้ชื่อกลุ่ม)') name
       FROM messages m LEFT JOIN groups g ON g.id = m.group_id
       WHERE date(m.ts,'+7 hours') BETWEEN ? AND ? ${groupId ? 'AND m.group_id = ?' : 'AND g.active = 1'}
       GROUP BY m.group_id, date
       ORDER BY date DESC, c DESC`,
    )
    .all(...args);
}

// ---------- สรุป "วันนี้คุยอะไรกันบ้าง" (cache เหมือน work_items) ----------
function getDigest(groupId, dateStr) {
  return db.prepare(`SELECT * FROM digests WHERE group_id = ? AND date = ?`).get(groupId, dateStr);
}
function saveDigest(groupId, dateStr, lastMsgId, data) {
  db.prepare(
    `INSERT INTO digests (group_id, date, last_msg_id, json, computed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(group_id, date) DO UPDATE SET
       last_msg_id = excluded.last_msg_id, json = excluded.json, computed_at = excluded.computed_at`,
  ).run(groupId, dateStr, lastMsgId, JSON.stringify(data));
}

// สถิติรายกลุ่มของวันหนึ่ง (ไว้ทำหน้าภาพรวม) — ทุกกลุ่มที่บอทยังอยู่ + กลุ่มที่ออกแล้วแต่วันนั้นมีแชท
function groupsOfDay(dateStr) {
  return db
    .prepare(
      `SELECT g.id, COALESCE(g.name,'(ยังไม่รู้ชื่อกลุ่ม)') name, g.active,
        (SELECT count(*) FROM messages m WHERE m.group_id=g.id AND date(m.ts,'+7 hours')=?) c,
        (SELECT min(ts) FROM messages m WHERE m.group_id=g.id AND date(m.ts,'+7 hours')=?) first_ts,
        (SELECT max(ts) FROM messages m WHERE m.group_id=g.id AND date(m.ts,'+7 hours')=?) last_ts,
        (SELECT max(id) FROM messages m WHERE m.group_id=g.id AND date(m.ts,'+7 hours')=?) last_msg_id,
        (SELECT count(*) FROM messages m WHERE m.group_id=g.id AND date(m.ts,'+7 hours')=?
           AND m.type IN ('image','audio','video','file')) media,
        (SELECT count(*) FROM extracts e WHERE e.group_id=g.id AND e.kind='money'
           AND date(e.ts,'+7 hours')=?) money
       FROM groups g
       WHERE g.active = 1 OR c > 0
       ORDER BY c DESC, g.name`,
    )
    .all(dateStr, dateStr, dateStr, dateStr, dateStr, dateStr);
}

// ใครคุยบ้างในวันนั้น (เรียงคนพูดเยอะก่อน)
function talkersOfDay(groupId, dateStr, limit = 5) {
  return db
    .prepare(
      `SELECT COALESCE(mb.display_name,'ไม่ทราบชื่อ') name, count(*) c
       FROM messages m LEFT JOIN members mb ON mb.group_id=m.group_id AND mb.user_id=m.user_id
       WHERE m.group_id = ? AND date(m.ts,'+7 hours') = ?
       GROUP BY name ORDER BY c DESC LIMIT ?`,
    )
    .all(groupId, dateStr, limit);
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
  setImageReply,
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
  getWorkItems,
  saveWorkItems,
  activeGroupDays,
  getDigest,
  saveDigest,
  groupsOfDay,
  talkersOfDay,
};
