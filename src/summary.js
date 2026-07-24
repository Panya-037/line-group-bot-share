// สรุปรายวันอัตโนมัติ — cron ทุกชั่วโมงเช็คว่ากลุ่มไหนถึงเวลาสรุป (push กินโควต้า 300/เดือน)
const cron = require('node-cron');
const dayjs = require('./time');
const { groupsDueForSummary, countPush, pushCount, messagesOfDay } = require('./db');
const { extractWorkItems } = require('./ai');
const { workSummaryFlex, workSummaryText } = require('./flex');

// ส่งข้อความเข้า Telegram แจ้งแอดมิน (ฟรี ไม่กินโควต้า LINE) — ไม่ตั้ง env = ข้ามเงียบๆ
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error('[telegram]', e.message);
  }
}

// สรุป "เฉพาะเรื่องงาน" เป็นการ์ดตารางแล้ว push เข้ากลุ่ม + สำเนาเข้า Telegram
// คุยเล่นล้วน/แชทเงียบ → ไม่ส่งเลย (ประหยัดทั้ง AI ทั้งโควต้า push)
async function pushDailySummary(client, group, dateStr, dateLabel) {
  const name = group.name || 'กลุ่ม';
  const rows = messagesOfDay(group.id, dateStr).filter((m) => !m.text?.startsWith('!'));
  if (rows.length < 3) {
    console.log(`[summary] ${name}: แชทเงียบ (${rows.length} ข้อความ) ข้ามไม่เรียก AI`);
    return false;
  }
  const data = await extractWorkItems(rows, { groupName: name });
  if (!data.tasks.length && !data.money.length && !data.pending.length) {
    console.log(`[summary] ${name}: วันนี้คุยเล่นล้วน ไม่มีเรื่องงาน — ข้ามไม่ push`);
    return false;
  }
  const payload = { groupName: name, dateLabel, dateStr, ...data };
  await client.pushMessage({ to: group.id, messages: [workSummaryFlex(payload)] });
  countPush(dayjs().format('YYYY-MM'));
  await sendTelegram(workSummaryText(payload));
  return true;
}

function startScheduler(client) {
  // นาที :05 ของทุกชั่วโมง (เวลาไทย) — กลุ่มไหน summary_hour ตรงชั่วโมงนี้ก็สรุปเลย
  cron.schedule(
    '5 * * * *',
    async () => {
      const hour = dayjs().hour();
      const due = groupsDueForSummary(hour);
      if (!due.length) return;
      const today = dayjs().format('YYYY-MM-DD');
      for (const g of due) {
        try {
          await pushDailySummary(client, g, today, 'วันนี้');
        } catch (e) {
          console.error(`[summary] ${g.id}:`, e.message);
        }
      }
      const used = pushCount(dayjs().format('YYYY-MM'));
      if (used >= 250) await sendTelegram(`⚠️ line-group-bot ใช้ push แล้ว ${used}/300 เดือนนี้ ใกล้เต็มโควต้าฟรี`);
    },
    { timezone: 'Asia/Bangkok' },
  );
  console.log('[scheduler] สรุปรายวันพร้อมทำงาน (เช็คทุกชั่วโมง นาที :05)');
}

module.exports = { startScheduler, pushDailySummary, sendTelegram };
