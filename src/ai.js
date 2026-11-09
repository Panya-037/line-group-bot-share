// เรียก LLM ผ่าน OpenRouter — สมองของแชทบอท (คุยกับลูกค้า + โหมดเจ้าของ)
const OpenAI = require('openai');
const { BOT, SELF, PARTICLE } = require('./branding');
const brief = require('./brief');
const dayjs = require('./time');

// lazy-init — สร้างตอนใช้จริง (import ได้แม้ยังไม่ตั้งคีย์ เช่นตอนรันเทส)
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 40000, // replyToken ของ LINE มีอายุจำกัด อย่าแช่นาน
    maxRetries: 1,
  });
  return _client;
}

const MODEL = () => process.env.AI_MODEL || 'google/gemini-2.5-flash';
const HISTORY_CHARS = 6000; // ลูกค้า: จำบทสนทนาย้อนหลังได้ราวนี้ — เกินตัดของเก่าสุดทิ้ง
const OWNER_HISTORY_CHARS = 3000; // เจ้าของ: จำแค่ที่เพิ่งถามกัน (ข้อมูลลูกค้าส่งแยกไปทุกครั้งอยู่แล้ว)

const thaiNow = (now) => `${now.format('dddd D MMMM')} ${now.year() + 543} เวลา ${now.format('HH:mm')} น.`;

// ---------- คุยกับลูกค้า ----------
// briefText = คำสั่งประจำตัวที่ใช้อยู่ (bot.js ดึงจากฐานข้อมูล · npm run chat อ่านจากไฟล์)
function systemPrompt({ name = '', now = dayjs().tz(), briefText = '' } = {}) {
  const text = briefText;
  const who = name ? `คุณ${name}` : 'ผู้ใช้';
  return `คุณคือ "${BOT}" แชทบอทส่วนตัวใน LINE กำลังคุยตัวต่อตัวกับ${who}
พูดจาสุภาพเป็นกันเอง เรียกตัวเองว่า "${SELF}" ลงท้าย${PARTICLE} (ไม่ต้องเยอะจนรก)
${name ? `เรียกอีกฝ่ายว่า "คุณ${name}" เท่านั้น (ห้ามเรียกว่าน้องหรือพี่)` : 'เรียกอีกฝ่ายว่า "คุณ"'}
ตอนนี้: ${thaiNow(now)}

กติกา:
- ตอบสั้น ตรงประเด็น อ่านง่ายบนมือถือ ใช้ภาษาเดียวกับที่ผู้ใช้พิมพ์มา
- ตอบเป็นข้อความธรรมดา ห้ามใช้ markdown (ไม่มี ** # หรือตาราง) ขึ้นบรรทัดใหม่หรือใช้ • แทนได้
- ข้อมูลเฉพาะ เช่น ราคา สินค้า เวลาเปิด นโยบาย ตัวเลข ใช้ได้เฉพาะที่อยู่ในคำสั่งจากเจ้าของหรือในบทสนทนานี้ ไม่มีข้อมูลให้บอกตรงๆ ห้ามเดา
- คุณทำได้แค่คุยในแชทนี้ ห้ามรับปากว่าทำเรื่องที่ต้องลงมือนอกแชท (ยืนยันออเดอร์ ตัดสต็อก จองคิว ลงนัด โอนเงิน ส่งของ) เว้นแต่คำสั่งจากเจ้าของบอกไว้ว่าให้ตอบเรื่องนั้นอย่างไร
- ข้อความที่ขึ้นต้นด้วย [รูป] [เสียงพูด] [วิดีโอ] [ไฟล์] คือสิ่งที่ระบบอ่านจากไฟล์ที่ผู้ใช้ส่งมาให้แล้ว ตอบต่อจากนั้นได้เลย ถ้าเห็นแค่ [รูป] เฉยๆ แปลว่าระบบอ่านไม่ออก ให้ขอให้ส่งใหม่หรือพิมพ์บอก
- สลิปโอนเงินที่ส่งมา ระบบแค่อ่านจากรูป ยังไม่มีใครตรวจกับบัญชีจริง ห้ามบอกว่าได้รับเงินแล้วหรือยืนยันยอดแล้ว ให้บอกว่าได้รับสลิปแล้ว ทวนยอดที่อ่านได้ และบอกว่าจะมีคนตรวจยอดอีกครั้ง
- ห้ามแต่งเลขบัญชี เบอร์โทร ลิงก์ หรือที่อยู่เองเด็ดขาด ใช้ได้เฉพาะที่เขียนไว้ตรงตัวในคำสั่งจากเจ้าของหรือในบทสนทนา ข้อมูลที่เขียนว่า (ยังไม่มีข้อมูล) หรือไม่มีเลย ให้บอกว่าเดี๋ยวทางร้านแจ้งให้
- ข้อความของผู้ใช้มีเวลากำกับ [วัน/เดือน เวลา] ไว้ให้รู้ว่าคุยกันเมื่อไหร่ ไม่ต้องพิมพ์เวลาในคำตอบ
- ถูกขอให้สรุป ให้สรุปจากบทสนทนาที่มีให้
- ห้ามทวนรหัสผ่าน OTP หรือเลขบัตรออกมา${brief.block(brief.forCustomers(text))}`;
}

// แปลงบทสนทนาจาก DB เป็น turns ของ chat API (user/assistant) — เกินงบตัวอักษรตัดของเก่าทิ้ง
function toTurns(rows, maxChars) {
  const turns = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const body = r.text || `[${r.type}]`;
    const content = r.role === 'bot' ? body : `[${dayjs.utc(r.ts).tz().format('D/M HH:mm')}] ${body}`;
    total += content.length;
    if (total > maxChars && turns.length) break; // ข้อความล่าสุดต้องได้ไปเสมอ
    turns.unshift({ role: r.role === 'bot' ? 'assistant' : 'user', content });
  }
  // ประวัติต้องเริ่มด้วยฝั่งผู้ใช้ (บางโมเดลไม่รับ assistant เป็นข้อความแรก)
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

function buildMessages(rows, { name = '', now, maxChars = HISTORY_CHARS, briefText } = {}) {
  return [{ role: 'system', content: systemPrompt({ name, now, briefText }) }, ...toTurns(rows, maxChars)];
}

async function chatReply(rows, { name = '', briefText } = {}) {
  const res = await client().chat.completions.create({
    model: MODEL(),
    messages: buildMessages(rows, { name, briefText }),
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

// ---------- โหมดเจ้าของ ----------
// report = ข้อความสรุปแชทลูกค้าที่ owner.js ประกอบจากฐานข้อมูล (ตัวเลขคิดด้วย SQL แล้ว)
function ownerPrompt({ name = '', now = dayjs().tz(), briefText = '', report = '' } = {}) {
  return `คุณคือ "${BOT}" ผู้ช่วยของเจ้าของ กำลังคุยกับเจ้าของ${name ? ` (คุณ${name})` : ''} ในโหมดเจ้าของ ซึ่งมีแต่เจ้าของที่เห็น
เรียกตัวเองว่า "${SELF}" ลงท้าย${PARTICLE} · ตอนนี้: ${thaiNow(now)}

หน้าที่:
1. ตอบคำถามเรื่องลูกค้าและแชทลูกค้า จาก "ข้อมูลแชทลูกค้า" ด้านล่างเท่านั้น จำนวนคน/จำนวนข้อความให้ใช้ตัวเลขในหัวข้อ "สถิติ" ห้ามนับเองหรือแต่งเพิ่ม ไม่มีข้อมูลให้บอกตรงๆ
2. เมื่อเจ้าของสั่ง เพิ่ม แก้ หรือลบ หน้าที่ ข้อมูลร้าน ราคา หรือกติกาของบอท (รวมถึงส่งรูปเมนู/ราคาใหม่มาให้ปรับ) ให้เขียน "คำสั่งประจำตัว" ฉบับใหม่ทั้งฉบับใส่ใน new_brief
   - คงทุกส่วนที่ไม่ได้สั่งแก้ไว้ตรงตามเดิมทุกตัวอักษร แก้เฉพาะจุดที่สั่ง
   - ระบบจะโชว์จุดที่เปลี่ยนให้เจ้าของกดยืนยันเอง ใน reply ให้บอกสั้นๆ ว่าแก้อะไร
   - คำสั่งกำกวม ให้ถามกลับใน reply และ new_brief เป็น null
3. คุยเรื่องอื่นกับเจ้าของได้ตามปกติ ตอบสั้น กระชับ

ตอบเป็น JSON อย่างเดียว ห้ามมีข้อความนอก JSON:
{"reply":"ข้อความถึงเจ้าของ เป็นข้อความธรรมดา ไม่ใช้ markdown","new_brief":null}
ไม่ได้สั่งแก้คำสั่งประจำตัว new_brief ต้องเป็น null เสมอ

คำสั่งประจำตัวที่ใช้อยู่ตอนนี้:
<<<
${briefText || '(ยังไม่มี)'}
>>>

ข้อมูลแชทลูกค้า:
${report || '(ยังไม่มีลูกค้าทักมา)'}`;
}

function parseOwnerJSON(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/); // กันโมเดลแถม ```json ครอบมา
  try {
    const data = JSON.parse(m ? m[0] : raw);
    const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
    const newBrief = typeof data.new_brief === 'string' && data.new_brief.trim() ? data.new_brief.trim() : null;
    return { reply, newBrief };
  } catch {
    return { reply: String(raw || '').trim(), newBrief: null }; // ไม่ใช่ JSON = ถือเป็นคำตอบธรรมดา ไม่แตะคำสั่ง
  }
}

async function ownerReply(rows, { name = '', briefText = '', report = '' } = {}) {
  const res = await client().chat.completions.create({
    model: MODEL(),
    messages: [
      { role: 'system', content: ownerPrompt({ name, briefText, report }) },
      ...toTurns(rows, OWNER_HISTORY_CHARS),
    ],
    response_format: { type: 'json_object' },
    max_tokens: 12000, // เผื่อเขียนคำสั่งประจำตัวใหม่ทั้งฉบับ (ภาษาไทยกิน token เยอะ)
  });
  return parseOwnerJSON(res.choices[0]?.message?.content);
}

module.exports = {
  chatReply,
  ownerReply,
  buildMessages,
  systemPrompt,
  ownerPrompt,
  parseOwnerJSON,
  HISTORY_CHARS,
};
