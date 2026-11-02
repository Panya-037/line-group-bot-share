// คัด "งานที่ต้องทำ" จากแชท — ใช้ร่วมกันระหว่างการ์ดสรุป 20:00 กับแดชบอร์ด
// หัวใจคือ cache: ผลของ AI ต่อ (กลุ่ม, วัน) เก็บลง work_items พร้อม id ข้อความล่าสุด
// เปิดแดชบอร์ดซ้ำ/ถึงเวลา push = อ่านของเดิม ไม่เรียก AI ใหม่ ถ้าไม่มีข้อความใหม่เข้ามา
const { messagesOfDay, getWorkItems, saveWorkItems, activeGroupDays } = require('./db');
const { extractWorkItems } = require('./ai');
const brief = require('./brief');

const QUIET_MIN = 3; // ต่ำกว่านี้ถือว่าแชทเงียบ ไม่คุ้มเรียก AI
const EMPTY = { tasks: [], money: [], pending: [] };

const inflight = new Map(); // กันเรียก AI ซ้อนตอนเปิดแดชบอร์ดรัวๆ

// แคชใช้ได้เมื่อไม่มีข้อความใหม่ *และ* คัดด้วยบรีฟตัวเดียวกับตอนนี้ (เปลี่ยน SUMMARY_FOCUS = อ่านใหม่)
function cacheFresh(cached, lastId) {
  return !!cached && cached.last_msg_id === lastId && (cached.brief_key || '') === brief.KEY;
}

function shape(data) {
  return {
    tasks: Array.isArray(data?.tasks) ? data.tasks : [],
    money: Array.isArray(data?.money) ? data.money : [],
    pending: Array.isArray(data?.pending) ? data.pending : [],
  };
}

// งานของกลุ่มหนึ่งในวันหนึ่ง — { data, quiet, usedAI }
async function workItemsFor(groupId, dateStr, { groupName = 'กลุ่ม', force = false } = {}) {
  const rows = messagesOfDay(groupId, dateStr).filter((m) => !m.text?.startsWith('!'));
  if (rows.length < QUIET_MIN) return { data: EMPTY, quiet: true, usedAI: false, count: rows.length };

  const lastId = rows[rows.length - 1].id;
  if (!force) {
    const cached = getWorkItems(groupId, dateStr);
    if (cacheFresh(cached, lastId)) {
      try {
        return { data: shape(JSON.parse(cached.json)), quiet: false, usedAI: false, count: rows.length };
      } catch {
        /* json เสีย — ปล่อยให้อ่านใหม่ */
      }
    }
  }

  const key = `${groupId}:${dateStr}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const data = shape(await extractWorkItems(rows, { groupName }));
    saveWorkItems(groupId, dateStr, lastId, data);
    return { data, quiet: false, usedAI: true, count: rows.length };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// รวมงานทุกกลุ่มในช่วงที่เลือก — จำกัดจำนวนครั้งที่เรียก AI ต่อการเปิดหนึ่งครั้ง
// คืน { items, skipped, usedAI } · items = [{ groupId, groupName, date, tasks, money, pending }]
async function collectWork({ from, to, groupId = null, maxFresh = 8, force = false } = {}) {
  const days = activeGroupDays(from, to, groupId).filter((d) => d.c >= QUIET_MIN);
  const items = [];
  let fresh = 0;
  let skipped = 0;

  for (const d of days) {
    const cached = getWorkItems(d.group_id, d.date);
    const isFresh = !force && cacheFresh(cached, d.last_msg_id);
    if (!isFresh && fresh >= maxFresh) {
      skipped++; // เกินโควต้ารอบนี้ — กดอัพเดตอีกทีค่อยอ่านต่อ
      continue;
    }
    try {
      const res = await workItemsFor(d.group_id, d.date, { groupName: d.name, force });
      if (res.usedAI) fresh++;
      if (res.data.tasks.length || res.data.money.length || res.data.pending.length) {
        items.push({ groupId: d.group_id, groupName: d.name, date: d.date, count: d.c, ...res.data });
      }
    } catch (e) {
      console.error(`[tasks] ${d.name} ${d.date}:`, e.message);
      skipped++; // กลุ่มเดียวพังไม่ล้มทั้งหน้า
    }
  }
  return { items, skipped, usedAI: fresh };
}

module.exports = { workItemsFor, collectWork, cacheFresh, QUIET_MIN };
