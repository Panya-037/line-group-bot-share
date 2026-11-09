// อ่านคอนเทนต์ที่ไม่ใช่ข้อความ — โหลดไฟล์จาก LINE แล้วให้ AI อ่าน/ถอดความ
// คืนเป็นข้อความ เช่น "[รูป] สลิปโอน 500 บาท" → บอทเอาไปคุยต่อได้เหมือนข้อความที่พิมพ์มา
// ส่งไฟล์ให้โมเดลตรงๆ ทุกชนิด (เสียง m4a / วิดีโอ mp4) — ไม่ต้องมี ffmpeg จึงรันบน Vercel ได้
const OpenAI = require('openai');

// client แยกจาก ai.js — ไฟล์ใหญ่ใช้เวลานานกว่า แต่ต้องเหลือเวลาให้ตอบทันอายุ replyToken
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 40000,
    maxRetries: 0,
  });
  return _client;
}
// อ่านรูป/ฟังเสียง/ดูวิดีโอ — ต้องเป็นโมเดลที่รับเสียงและวิดีโอได้ (ตระกูล gemini)
// gemini-3.1-flash-lite: ถอดเสียงไทยได้เท่า 2.5-flash แต่ไวกว่า 2–3 เท่า ราคาครึ่งเดียว (ทดสอบ 9 พ.ย. 69) · อ่านสลิปไทยจริงถูก 10/10
const VISION_MODEL = () => process.env.VISION_MODEL || 'google/gemini-3.1-flash-lite';

const MAX_BYTES = 15 * 1024 * 1024; // เกิน 15MB ไม่โหลด (กันไฟล์ยักษ์)

// โหลดตัวไฟล์จาก LINE (คนละโดเมนกับ api ปกติ — api-data.line.me)
async function downloadContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`โหลดคอนเทนต์ไม่ได้ (${res.status})`);
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > MAX_BYTES) throw new Error(`ไฟล์ใหญ่เกิน (${(len / 1e6).toFixed(1)}MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`ไฟล์ใหญ่เกิน (${(buf.length / 1e6).toFixed(1)}MB)`);
  return buf;
}

async function ask(prompt, part) {
  const res = await client().chat.completions.create({
    model: VISION_MODEL(),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, part] }],
  });
  return res.choices[0]?.message?.content?.trim().slice(0, 3000) || '';
}

const READ_IMAGE =
  'อ่านรูปนี้แล้วตอบเป็นภาษาไทย: รูปทั่วไปอธิบายกระชับ 1-3 ประโยค แต่ถ้ามีข้อความในรูป (สลิปโอนเงิน เอกสาร แชท ตาราง รายการสั่งของ ฉลากสินค้า เมนู) ให้ถอดออกมาให้ครบพร้อมตัวเลขสำคัญ (ยอดเงิน วันที่เวลา ชื่อ เลขที่ ราคา) ตรงไหนอ่านไม่ชัดใส่ (?) ตอบเฉพาะเนื้อหา ไม่ต้องเกริ่น';

function describeImage(buf) {
  const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return ask(READ_IMAGE, { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
}

// เสียงจาก LINE เป็น m4a — ทดสอบแล้ว gemini ถอดเสียงไทยได้ตรงๆ ไม่ต้องแปลงไฟล์
function transcribeAudio(buf) {
  return ask('ถอดเสียงพูดในไฟล์นี้เป็นข้อความตรงตามที่พูด (ภาษาไทยหรือภาษาที่พูดจริง) ตอบเฉพาะข้อความที่ถอดได้ ไม่ต้องเกริ่น', {
    type: 'input_audio',
    input_audio: { data: buf.toString('base64'), format: 'm4a' },
  });
}

// วิดีโอส่งทั้งไฟล์ — โมเดลดูได้ทั้งภาพ ข้อความในคลิป และเสียงพูด
function describeVideo(buf) {
  return ask(
    'ดูวิดีโอนี้แล้วตอบเป็นภาษาไทยกระชับ: เกิดอะไรขึ้นในคลิป มีข้อความบนจออะไรบ้าง และถ้ามีคนพูด ให้สรุปว่าพูดอะไร ตอบเฉพาะเนื้อหา ไม่ต้องเกริ่น',
    { type: 'video_url', video_url: { url: `data:video/mp4;base64,${buf.toString('base64')}` } },
  );
}

// ---------- ไฟล์เอกสาร ----------
const TEXT_EXTS = new Set(['txt', 'csv', 'json', 'md', 'log', 'tsv']);
async function readFileContent(fileName, buf) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (TEXT_EXTS.has(ext)) return buf.toString('utf8').slice(0, 2000);
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // เรียกไฟล์ข้างในตรงๆ — ตัวหลักไปอ่านไฟล์ทดสอบตอน import บนเซิร์ฟเวอร์บางแบบ
    const parsed = await pdfParse(buf);
    return (parsed.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }
  return null; // นามสกุลอื่น — เก็บแค่ชื่อไฟล์พอ
}

// ---------- จุดเข้า: อ่านแล้วคืนข้อความ (null = อ่านไม่ได้ ให้ใช้ placeholder เดิม) ----------
async function readMedia(msg) {
  try {
    if (msg.type === 'image') return `[รูป] ${await describeImage(await downloadContent(msg.id))}`;
    if (msg.type === 'audio') return `[เสียงพูด] ${await transcribeAudio(await downloadContent(msg.id))}`;
    if (msg.type === 'video') return `[วิดีโอ] ${await describeVideo(await downloadContent(msg.id))}`;
    if (msg.type === 'file') {
      const body = await readFileContent(msg.fileName || '', await downloadContent(msg.id));
      return body ? `[ไฟล์ ${msg.fileName}] ${body}` : null;
    }
  } catch (e) {
    console.error(`[media] ${msg.type} ${msg.id}:`, e.message);
  }
  return null;
}

module.exports = { readMedia, readFileContent };
