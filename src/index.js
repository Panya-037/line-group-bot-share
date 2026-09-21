require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');
const dayjs = require('./time');
const {
  db,
  ensureGroup,
  setGroupName,
  deactivateGroup,
  upsertMember,
  memberName,
  logMessage,
  deleteByLineMsgId,
  logExtract,
  pushCount,
} = require('./db');
const { handleCommand, summarizeDay } = require('./commands');
const { getGroupSummary, getGroupMemberProfile, getRoomMemberProfile, getBotInfo } = require('./lineapi');
const { startScheduler, pushDailySummary } = require('./summary');
const { extractMoney } = require('./extract');
const { processMedia } = require('./media');
const { welcomeFlex } = require('./flex');
const { renderDashboard, renderReport, parseFilters } = require('./dashboard');
const { collectWork } = require('./tasks');
const { BOT, SELF, EMOJI, say } = require('./branding');

// handleCommand คืนได้ทั้ง string / message object (การ์ด) / array → ทำให้เป็น messages เสมอ
function toMessages(answer) {
  if (Array.isArray(answer)) return answer;
  if (typeof answer === 'string') return [{ type: 'text', text: say(answer).slice(0, 4900) }];
  return [answer]; // การ์ด Flex (ผ่าน say() มาจาก flex.js แล้ว)
}

// เตือนค่าที่ยังไม่ได้ตั้ง แต่ไม่ปิดเซิร์ฟเวอร์ — จะได้เปิดแดชบอร์ดโหมดลองเล่นได้แม้ยังไม่ผูก LINE
const missing = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'OPENROUTER_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`⚠️  ยังไม่ได้ตั้งค่า: ${missing.join(', ')} — บอทไลน์จะยังไม่ทำงานจนกว่าจะตั้งครบ (แดชบอร์ด /admin ยังเปิดดูได้) ดูวิธีใน README.md`);
}

const middlewareConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET };
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

let botUserId = null; // ไว้เช็คว่าโดน mention ไหม — ดึงตอน start

const app = express();

// ---------- helpers ----------

// ข้อความที่ไม่ใช่ text → เก็บ placeholder ไว้ก่อน แล้ว processMedia ค่อยอ่านจริงแบบ async
function placeholder(message) {
  switch (message.type) {
    case 'image':
      return '[รูป]';
    case 'sticker': {
      // สติกเกอร์มี keyword อารมณ์ติดมา (บางตัว) — จดไว้ให้สรุปรู้บรรยากาศ
      const kw = (message.keywords || []).slice(0, 3).join(' ');
      return kw ? `[สติกเกอร์: ${kw}]` : '[สติกเกอร์]';
    }
    case 'video':
      return '[วิดีโอ]';
    case 'audio':
      return '[เสียงพูด]';
    case 'file':
      return `[ไฟล์] ${message.fileName || ''}`.trim();
    case 'location':
      return `[ตำแหน่ง] ${[message.title, message.address].filter(Boolean).join(' ')}`.trim();
    default:
      return `[${message.type}]`;
  }
}

// โดน mention ไหม → คืนข้อความที่ตัดชื่อบอทออก (null = ไม่โดน)
function mentionQuestion(message, selfId) {
  const men = message.mention?.mentionees || [];
  const mine = men.find((m) => m.isSelf === true || (selfId && m.userId === selfId));
  if (!mine) return null;
  const t = message.text || '';
  return (t.slice(0, mine.index) + t.slice(mine.index + mine.length)).trim();
}

// จำชื่อสมาชิก — ยังไม่รู้จักค่อยยิง API (คนไม่ยินยอมเปิดโปรไฟล์จะ 404 ก็ปล่อยเป็น "ไม่ทราบชื่อ")
async function rememberMember(srcType, srcId, userId) {
  if (!userId || memberName(srcId, userId) !== 'ไม่ทราบชื่อ') return;
  try {
    const p =
      srcType === 'room' ? await getRoomMemberProfile(srcId, userId) : await getGroupMemberProfile(srcId, userId);
    if (p?.displayName) upsertMember(srcId, userId, p.displayName);
  } catch {
    /* โปรไฟล์ปิด — ข้าม */
  }
}

async function refreshGroupName(srcType, srcId) {
  if (srcType !== 'group') return 'แชทกลุ่มย่อย'; // room ไม่มี API ชื่อ
  try {
    const s = await getGroupSummary(srcId);
    if (s?.groupName) {
      setGroupName(srcId, s.groupName);
      return s.groupName;
    }
  } catch {
    /* ignore */
  }
  return db.prepare(`SELECT name FROM groups WHERE id = ?`).get(srcId)?.name || 'กลุ่ม';
}

// ---------- webhook ----------
// ตั้ง LINE_CHANNEL_SECRET แล้วค่อยเปิด /webhook (โหมดลองเล่นไม่มี secret → แดชบอร์ดยังทำงาน)
if (process.env.LINE_CHANNEL_SECRET) {
  app.post('/webhook', line.middleware(middlewareConfig), (req, res) => {
    res.sendStatus(200); // ตอบ LINE ก่อน ค่อยประมวลผล (กัน timeout)
    for (const event of req.body.events || []) {
      handleEvent(event).catch((e) => console.error('[event]', e.message));
    }
  });
} else {
  app.post('/webhook', (_req, res) => res.status(503).send('LINE ยังไม่ได้ตั้งค่า — ดู README.md'));
}

async function handleEvent(event) {
  const src = event.source || {};
  const srcType = src.type; // 'user' | 'group' | 'room'
  const srcId = src.groupId || src.roomId;

  // --- บอทถูกเชิญเข้ากลุ่ม ---
  if (event.type === 'join' && srcId) {
    ensureGroup(srcId);
    const name = await refreshGroupName(srcType, srcId);
    console.log(`[join] เข้ากลุ่ม "${name}" (${srcId})`);
    return client.replyMessage({ replyToken: event.replyToken, messages: [welcomeFlex()] });
  }

  // --- บอทออก/โดนเตะจากกลุ่ม ---
  if (event.type === 'leave' && srcId) {
    deactivateGroup(srcId);
    console.log(`[leave] ออกจากกลุ่ม ${srcId}`);
    return;
  }

  // --- สมาชิกใหม่เข้ากลุ่ม → จำชื่อไว้เลย ---
  if (event.type === 'memberJoined' && srcId) {
    for (const m of event.joined?.members || []) await rememberMember(srcType, srcId, m.userId);
    return;
  }

  // --- คนกด unsend → ลบ log ตาม (เคารพเจตนาคนลบ) ---
  if (event.type === 'unsend' && event.unsend?.messageId) {
    if (deleteByLineMsgId(event.unsend.messageId)) console.log('[unsend] ลบ log ตาม 1 ข้อความ');
    return;
  }

  if (event.type !== 'message') return;

  // --- แชท 1:1 — บอทตัวนี้ทำงานในกลุ่มเป็นหลัก ---
  if (srcType === 'user') {
    if (event.message.type !== 'text') return;
    console.log(`[dm] ${src.userId}: ${event.message.text}`);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: say(`สวัสดีค่ะ ${BOT}เป็นบอทผู้ช่วยประจำกลุ่มนะคะ ${EMOJI} ลองเชิญ${SELF}เข้ากลุ่ม (invite เหมือนเพื่อนคนนึง) แล้ว${SELF}จะช่วยจด+สรุปแชทให้ค่ะ พิมพ์ !ช่วย ในกลุ่มดูคำสั่งได้เลยนะคะ`),
        },
      ],
    });
  }

  if (!srcId) return;
  ensureGroup(srcId); // เผื่อบอทอยู่ในกลุ่มมาก่อน deploy (ไม่มี event join)
  await rememberMember(srcType, srcId, src.userId);

  const msg = event.message;

  // ข้อความไม่ใช่ text → เก็บ placeholder ก่อน แล้วให้ AI อ่านตัวจริงเบื้องหลัง
  if (msg.type !== 'text') {
    const rowId = logMessage(srcId, src.userId, msg.id, msg.type, placeholder(msg));
    if (['image', 'audio', 'video', 'file'].includes(msg.type)) {
      // ส่ง replyToken ติดไปด้วย — media.js จะใช้ตอบสรุปทันทีเฉพาะกลุ่มที่เปิด !อ่านรูป
      const replyCtx = { client, replyToken: event.replyToken };
      processMedia(srcId, rowId, msg, replyCtx).catch((e) => console.error('[media]', e.message));
    }
    return;
  }

  const text = msg.text;
  const rowId = logMessage(srcId, src.userId, msg.id, 'text', text);

  // ดักจับยอดเงิน (ข้ามบรรทัดคำสั่ง)
  if (!text.startsWith('!')) {
    for (const v of extractMoney(text)) logExtract(srcId, rowId, 'money', v);
  }

  // คำสั่ง / mention → ตอบในกลุ่ม (reply ฟรี)
  const q = mentionQuestion(msg, botUserId);
  if (text.startsWith('!') || q !== null) {
    const groupName = await refreshGroupName(srcType, srcId);
    try {
      const answer = await handleCommand(srcId, groupName, text, q);
      if (answer) {
        await client.replyMessage({ replyToken: event.replyToken, messages: toMessages(answer) });
      }
    } catch (e) {
      console.error('[command]', e.message);
      await client
        .replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: say(`ขอโทษนะคะ ระบบ${SELF}สะดุดนิดหน่อย ลองใหม่อีกทีได้เลยค่ะ 🙏`) }],
        })
        .catch(() => {});
    }
  }
}

// ---------- admin ----------
function checkKey(req, res) {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    res.status(403).send('forbidden');
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// แดชบอร์ด — ภาพรวมตามฟิลเตอร์ ?range=today|7|30 &group=<id> (โค้ดหน้าอยู่ที่ src/dashboard.js)
app.get('/admin', (req, res) => {
  if (!checkKey(req, res)) return;
  res.send(renderDashboard(req.query.key, req.query));
});

// งานที่ต้องทำในช่วงที่เลือก — หน้าแดชบอร์ดเรียกทีหลัง (ไม่ให้หน้ารอ AI)
// ใช้ผลที่ cache ไว้ก่อนเสมอ อ่านใหม่เฉพาะกลุ่ม/วันที่มีข้อความเพิ่ม หรือกดปุ่ม "อ่านใหม่" (force=1)
app.get('/admin/tasks.json', async (req, res) => {
  if (!checkKey(req, res)) return;
  const hasAI = !!process.env.OPENROUTER_API_KEY;
  const f = parseFilters(req.query);
  const force = req.query.force === '1';
  // ไม่มีคีย์ AI = ไม่คัดใหม่ แต่ยังโชว์ของที่เคยคัดไว้ได้ (โหมดลองเล่นจะได้เห็นการ์ดจริง)
  const quota = hasAI ? (force ? 12 : 8) : 0;
  try {
    const out = await collectWork({
      from: f.from,
      to: f.to,
      groupId: f.groupId,
      force,
      maxFresh: quota,
    });
    // เปิดตอนเช้าแล้วยังไม่มีใครคุย = การ์ดว่างเปล่า ไม่มีประโยชน์ → ถอยไปหยิบงานค้าง 7 วันล่าสุดมาโชว์แทน
    if (!out.items.length && f.range === 'today') {
      const back = await collectWork({
        from: dayjs().subtract(6, 'day').format('YYYY-MM-DD'),
        to: f.to,
        groupId: f.groupId,
        force,
        maxFresh: Math.min(6, quota),
      });
      if (back.items.length) {
        return res.json({ ...back, note: say('วันนี้ยังไม่มีงานใหม่ — นี่คืองานที่ค้างจาก 7 วันล่าสุดค่ะ') });
      }
    }
    if (!hasAI && !out.items.length) {
      return res.json({ items: [], skipped: 0, note: say(`ยังไม่ได้ตั้ง OPENROUTER_API_KEY — ${SELF}เลยยังคัดงานให้ไม่ได้ค่ะ`) });
    }
    res.json(out);
  } catch (e) {
    console.error('[tasks.json]', e.message);
    res.status(500).json({ items: [], skipped: 0, note: say('อ่านงานไม่สำเร็จค่ะ') });
  }
});

// รายงานสรุปแชทวันนี้ทุกกลุ่ม (สำหรับดูเอง ไม่ push เข้ากลุ่ม) — cache กัน AI ทำงานซ้ำตอนรีเฟรช
const reportCache = new Map(); // key `${groupId}:${dateStr}` → prose
app.get('/admin/report', async (req, res) => {
  if (!checkKey(req, res)) return;
  const dateStr = dayjs().format('YYYY-MM-DD');
  if (!process.env.OPENROUTER_API_KEY) {
    return res.send(renderReport([], req.query.key, dateStr, 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY — ตั้งค่าก่อนถึงจะสรุปได้'));
  }
  const groups = db.prepare(`SELECT * FROM groups WHERE active = 1 ORDER BY id`).all();
  const items = [];
  for (const g of groups) {
    const cacheKey = `${g.id}:${dateStr}`;
    let prose = reportCache.get(cacheKey);
    if (prose === undefined) {
      try {
        prose = await summarizeDay(g.id, g.name || 'กลุ่ม', dateStr, 'วันนี้');
        reportCache.set(cacheKey, prose); // แคชเฉพาะที่สำเร็จ
      } catch (e) {
        console.error(`[report] ${g.id}:`, e.message);
        continue; // กลุ่มนี้สรุปไม่ได้ ข้ามไป ไม่ให้ทั้งหน้าล่ม
      }
    }
    if (prose.includes('😴')) continue; // ข้ามกลุ่มที่เงียบ ไม่มีอะไรให้สรุป
    const count = db
      .prepare(`SELECT count(*) c FROM messages WHERE group_id=? AND date(ts,'+7 hours')=?`)
      .get(g.id, dateStr).c;
    items.push({ name: g.name || '(ยังไม่รู้ชื่อกลุ่ม)', active: g.active, count, prose });
  }
  // เก็บ cache เฉพาะของวันนี้ (ลบวันเก่าออก กันบวม)
  for (const key of reportCache.keys()) if (!key.endsWith(`:${dateStr}`)) reportCache.delete(key);
  res.send(renderReport(items, req.query.key, dateStr));
});

// พรีวิว/ยิงสรุปเอง: /admin/summary?key=&group=<id>[&date=YYYY-MM-DD][&send=1]
app.get('/admin/summary', async (req, res) => {
  if (!checkKey(req, res)) return;
  const g = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(req.query.group || '');
  if (!g) return res.status(404).send('ไม่เจอกลุ่มนี้');
  const dateStr = req.query.date || dayjs().format('YYYY-MM-DD');
  const label = dateStr === dayjs().format('YYYY-MM-DD') ? 'วันนี้' : `วันที่ ${dateStr}`;
  try {
    if (req.query.send === '1') {
      const sent = await pushDailySummary(client, g, dateStr, label);
      return res.send(sent ? 'ส่งสรุปเข้ากลุ่มแล้ว ✅' : 'แชทเงียบ ไม่มีอะไรให้สรุป — ไม่ได้ส่ง');
    }
    const text = await summarizeDay(g.id, g.name || 'กลุ่ม', dateStr, label);
    res.type('text/plain').send(text);
  } catch (e) {
    res.status(500).send(`สรุปไม่สำเร็จ: ${e.message}`);
  }
});

// ดาวน์โหลด DB ไว้ backup (แพทเทิร์นเดียวกับ nailaoma)
app.get('/admin/backup', (req, res) => {
  if (!checkKey(req, res)) return;
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'groupbot.db');
  db.pragma('wal_checkpoint(TRUNCATE)');
  res.download(file, `groupbot-${dayjs().format('YYYY-MM-DD')}.db`);
});

// ---------- start ----------
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`${BOT} (line-group-bot) ฟังอยู่ที่พอร์ต ${port}`);
  try {
    const info = await getBotInfo();
    botUserId = info.userId;
    console.log(`[bot] ${info.displayName} (${botUserId})`);
  } catch (e) {
    console.error('[bot] ดึงข้อมูลบอทไม่ได้ (mention detection ใช้ isSelf อย่างเดียว):', e.message);
  }
  startScheduler(client);
});
