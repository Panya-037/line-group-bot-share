// เรียก LLM ผ่าน OpenRouter (นโยบายบ้านนี้: OpenRouter ก่อนเสมอ)
const OpenAI = require('openai');
const dayjs = require('./time');

// lazy-init — สร้างตอนใช้จริง (import ได้แม้ยังไม่ตั้งคีย์ เช่นตอนรันเทส)
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 25000, // replyToken LINE อายุ ~1 นาที อย่าแช่นาน
    maxRetries: 1,
  });
  return _client;
}

const MODEL = () => process.env.AI_MODEL || 'google/gemini-2.5-flash';

// แปลงแถว messages เป็นบรรทัดอ่านง่ายให้โมเดล: [HH:mm] ชื่อ: ข้อความ
function toLines(rows, maxChars = 14000) {
  const lines = rows.map(
    (m) => `[${dayjs.utc(m.ts).tz().format('HH:mm')}] ${m.name}: ${m.text || `(${m.type})`}`,
  );
  // เกินงบตัวอักษร → ตัดหัว (เก็บช่วงท้ายที่สดกว่า)
  let total = 0;
  const kept = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxChars) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

async function ask(system, user) {
  const res = await client().chat.completions.create({
    model: MODEL(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

// สรุปแชทหนึ่งวันของกลุ่ม
async function summarizeChat(rows, { groupName, dateLabel }) {
  const chat = toLines(rows);
  return ask(
    `คุณเป็นเลขาสรุปแชทกลุ่ม LINE ภาษาไทย กระชับ อ่านง่ายบนมือถือ ห้ามแต่งเรื่องเกินจากแชท
ตอบเป็นข้อความธรรมดา (ไม่ใช่ markdown) โครงนี้ ข้ามหัวข้อที่ไม่มีข้อมูลไปเลย:
📌 ประเด็นหลัก — bullet สั้นๆ ไม่เกิน 5 ข้อ
✅ งาน/นัดหมาย — ใครต้องทำอะไร เมื่อไหร่
💰 ตัวเลข/ยอดเงิน — ยอดโอน ราคา จำนวน ที่พูดถึง
⏳ เรื่องค้าง — คำถามที่ยังไม่มีคนตอบ / เรื่องที่ต้องตามต่อ`,
    `สรุปแชทกลุ่ม "${groupName}" ของ${dateLabel}:\n\n${chat}`,
  );
}

// ตอบคำถามโดยใช้แชทล่าสุดเป็นบริบท
async function answerQuestion(rows, question, { groupName }) {
  const chat = toLines(rows);
  return ask(
    `คุณคือ "น้องฟ้าใส" บอทผู้ช่วยประจำกลุ่ม LINE "${groupName}" พูดจาสุภาพเป็นกันเอง เรียกตัวเองว่า "น้อง" ลงท้ายค่ะ/นะคะ (แต่ไม่ต้องเยอะจนรก) ตอบคำถามจากประวัติแชทที่ให้มาเท่านั้น
ตอบภาษาไทย สั้น ตรงประเด็น ถ้าในแชทไม่มีข้อมูลให้บอกตรงๆ ว่าน้องหาไม่เจอ อย่าเดา
ตอบเป็นข้อความธรรมดา ไม่ใช้ markdown`,
    `ประวัติแชทล่าสุด:\n\n${chat}\n\nคำถาม: ${question}`,
  );
}

// คัดเฉพาะ "เรื่องงาน" เป็นข้อมูลมีโครงสร้าง (ไว้ทำการ์ดตาราง) — ตัดคุยเล่นทิ้งทั้งหมด
async function extractWorkItems(rows, { groupName }) {
  const chat = toLines(rows);
  const raw = await ask(
    `คุณเป็นเลขาคัดสรุปงานจากแชทกลุ่ม หน้าที่: เก็บเฉพาะเรื่องงาน/นัดหมาย/เงิน/เรื่องค้างที่ต้องตาม — การคุยเล่น ทักทาย มุกตลก สติกเกอร์ ตัดทิ้งทั้งหมดห้ามเอามา
ตอบเป็น JSON ล้วนๆ เท่านั้น ห้ามมีข้อความอื่นนอก JSON รูปแบบ:
{"tasks":[{"task":"งานที่ต้องทำ (สั้น กระชับ)","owner":"ชื่อคนรับผิดชอบ หรือ - ถ้าไม่ระบุ","due":"กำหนดเวลา เช่น พรุ่งนี้ 10:00 หรือ - ถ้าไม่ระบุ"}],"money":[{"item":"ค่าอะไร/โอนอะไร","amount":"จำนวนเงิน"}],"pending":["คำถามหรือเรื่องที่ยังไม่มีข้อสรุป"]}
ถ้าทั้งวันไม่มีเรื่องงานเลย (คุยเล่นล้วน) ตอบ {"tasks":[],"money":[],"pending":[]}`,
    `แชทกลุ่ม "${groupName}" วันนี้:\n\n${chat}`,
  );
  const m = raw.match(/\{[\s\S]*\}/); // กันโมเดลแถมข้อความ/```json ครอบมา
  const data = JSON.parse(m ? m[0] : raw);
  return {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    money: Array.isArray(data.money) ? data.money : [],
    pending: Array.isArray(data.pending) ? data.pending : [],
  };
}

module.exports = { summarizeChat, answerQuestion, extractWorkItems };
