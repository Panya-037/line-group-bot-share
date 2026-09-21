// สรุป "วันนี้กลุ่มนี้คุยอะไรกันบ้าง" รายกลุ่มรายวัน — ใช้ในหน้าภาพรวม /admin/overview
// แพทเทิร์นเดียวกับ tasks.js: cache ผล AI ไว้ใน digests เทียบ last_msg_id → เปิดซ้ำไม่เรียก AI ใหม่
const dayjs = require('./time');
const { messagesOfDay, getDigest, saveDigest, getWorkItems, talkersOfDay } = require('./db');
const { digestDay } = require('./ai');

const LIGHT_MAX = 3; // ต่ำกว่านี้ = ข้อความไม่กี่บรรทัด โชว์ของจริงดีกว่าให้ AI สรุป
const FRESH_MIN = 5; // สรุปที่เพิ่งทำไม่ถึงกี่นาที ถือว่ายังใหม่พอ ไม่ต้องเรียก AI ซ้ำ
const inflight = new Map();

// ข้อความไม่กี่บรรทัด — โชว์ตัวจริงเลย (ฟรี อ่านง่ายกว่าสรุป)
function rawLines(rows) {
  return rows.slice(0, 5).map((m) => ({
    time: dayjs.utc(m.ts).tz().format('HH:mm'),
    who: m.name,
    text: (m.text || `(${m.type})`).slice(0, 140),
  }));
}

async function digestFor(groupId, dateStr, { groupName = 'กลุ่ม', dateLabel = 'วันนี้', force = false } = {}) {
  const rows = messagesOfDay(groupId, dateStr).filter((m) => !m.text?.startsWith('!'));
  const talkers = talkersOfDay(groupId, dateStr);
  const base = { groupId, count: rows.length, talkers };

  if (!rows.length) return { ...base, empty: true, usedAI: false };
  if (rows.length < LIGHT_MAX) return { ...base, light: true, raw: rawLines(rows), usedAI: false };

  const lastId = rows[rows.length - 1].id;
  const work = getWorkItems(groupId, dateStr);
  const taskCount =
    work && work.last_msg_id === lastId ? (JSON.parse(work.json).tasks || []).length : null;

  const done = (data, usedAI) => ({ ...base, ...data, taskCount, usedAI });

  if (!force) {
    const cached = getDigest(groupId, dateStr);
    if (cached) {
      // ยอดข้อความเท่าเดิม = ใช้ของเดิมได้เลย · มีข้อความใหม่แต่เพิ่งสรุปไปไม่ถึง 5 นาที = ยังใช้ของเดิม
      // (กันคนกดรีเฟรชรัวๆ ตอนกลุ่มกำลังคุยกันแล้วเรียก AI ทุกครั้ง) แต่ติดธง stale ให้หน้าเว็บบอกว่ามีของใหม่
      const sameTip = cached.last_msg_id === lastId;
      const ageMin = dayjs().diff(dayjs.utc(cached.computed_at), 'minute');
      if (sameTip || ageMin < FRESH_MIN) {
        try {
          return done({ ...JSON.parse(cached.json), stale: !sameTip }, false);
        } catch {
          /* json เสีย — สรุปใหม่ */
        }
      }
    }
  }

  const key = `${groupId}:${dateStr}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const data = await digestDay(rows, { groupName, dateLabel });
    saveDigest(groupId, dateStr, lastId, data);
    return done(data, true);
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

module.exports = { digestFor, LIGHT_MAX };
