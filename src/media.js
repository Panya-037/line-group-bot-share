// อ่านคอนเทนต์ที่ไม่ใช่ข้อความ — โหลดไฟล์จาก LINE แล้วให้ AI อ่าน/ถอดความ
// ผลลัพธ์เขียนทับ placeholder ใน messages → ค้นหา/สรุป/ถามต่อได้เหมือนข้อความปกติ
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const OpenAI = require('openai');
const { updateMessageText, logExtract, getGroup } = require('./db');
const { SELF } = require('./branding');
const { extractMoney } = require('./extract');
const { proseCard } = require('./flex');

// client แยกจาก ai.js — งาน media ไม่ผูก replyToken รอได้นานกว่า (60s)
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 60000,
    maxRetries: 1,
  });
  return _client;
}
const VISION_MODEL = () => process.env.VISION_MODEL || 'google/gemini-2.5-flash';

const MAX_BYTES = 15 * 1024 * 1024; // เกิน 15MB ไม่โหลด (กันไฟล์ยักษ์)

// โหลดตัวไฟล์จาก LINE (คนละโดเมนกับ api ปกติ — api-data.line.me)
async function downloadContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`โหลดคอนเทนต์ไม่ได้ (${res.status})`);
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > MAX_BYTES) throw new Error(`ไฟล์ใหญ่เกิน (${(len / 1e6).toFixed(1)}MB)`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- รูป ----------
async function describeImage(buf) {
  const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const res = await client().chat.completions.create({
    model: VISION_MODEL(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'อ่านรูปนี้แล้วตอบเป็นภาษาไทย: รูปทั่วไปอธิบายกระชับ 1-3 ประโยค แต่ถ้ามีข้อความในรูป (สลิปโอนเงิน เอกสาร แชท ตาราง กระดานงาน รายการสั่งของ) ให้ถอดออกมาให้ครบทุกรายการพร้อมตัวเลขสำคัญ (ยอดเงิน วันที่เวลา ชื่อ สถานที่ เลขที่) ถ้าเป็นรายการ/กระดานงาน ให้ขึ้นบรรทัดละรายการ รายการที่ถูกขีดฆ่าหรือติ๊กถูกให้ต่อท้ายว่า [เสร็จแล้ว] ตรงไหนอ่านไม่ชัดใส่ (?) แล้วปิดท้ายด้วยสรุป 1 บรรทัดว่ามีกี่รายการ เสร็จกี่รายการ ตอบเฉพาะเนื้อหา ไม่ต้องเกริ่น',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content?.trim().slice(0, 3000) || '';
}

// ---------- เสียง / วิดีโอ (ใช้ ffmpeg — บน Railway ติดตั้งผ่าน nixpacks.toml) ----------
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}
function tmpFile(name) {
  return path.join(os.tmpdir(), `groupbot-${process.pid}-${name}`);
}

async function transcribeAudio(buf, messageId) {
  const inFile = tmpFile(`${messageId}.m4a`);
  const outFile = tmpFile(`${messageId}.mp3`);
  try {
    fs.writeFileSync(inFile, buf);
    ffmpeg(['-i', inFile, outFile]); // m4a → mp3 (OpenRouter รับ wav/mp3)
    const b64 = fs.readFileSync(outFile).toString('base64');
    const res = await client().chat.completions.create({
      model: VISION_MODEL(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ถอดเสียงพูดในไฟล์นี้เป็นข้อความตรงตามที่พูด (ภาษาไทยหรือภาษาที่พูดจริง) ตอบเฉพาะข้อความที่ถอดได้ ไม่ต้องเกริ่น' },
            { type: 'input_audio', input_audio: { data: b64, format: 'mp3' } },
          ],
        },
      ],
    });
    return res.choices[0]?.message?.content?.trim().slice(0, 3000) || '';
  } finally {
    for (const f of [inFile, outFile]) fs.rmSync(f, { force: true });
  }
}

async function describeVideo(buf, messageId) {
  const inFile = tmpFile(`${messageId}.mp4`);
  const frameFile = tmpFile(`${messageId}.jpg`);
  try {
    fs.writeFileSync(inFile, buf);
    ffmpeg(['-ss', '1', '-i', inFile, '-frames:v', '1', frameFile]); // ดึงเฟรมวินาทีที่ 1
    return await describeImage(fs.readFileSync(frameFile));
  } finally {
    for (const f of [inFile, frameFile]) fs.rmSync(f, { force: true });
  }
}

// ---------- ไฟล์เอกสาร ----------
const TEXT_EXTS = new Set(['txt', 'csv', 'json', 'md', 'log', 'tsv']);
async function readFileContent(fileName, buf) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (TEXT_EXTS.has(ext)) return buf.toString('utf8').slice(0, 2000);
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buf);
    return (parsed.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }
  return null; // นามสกุลอื่น — เก็บแค่ชื่อไฟล์พอ
}

// ---------- จุดเข้า: ประมวลผลแล้วอัพเดท log (เรียกแบบ async ไม่บล็อค webhook) ----------
// replyCtx = { client, replyToken } — มีเมื่ออยากให้ตอบสรุปกลับเข้ากลุ่มได้ (ใช้เฉพาะกลุ่มที่เปิด !อ่านรูป)
async function processMedia(groupId, rowId, msg, replyCtx) {
  let text = null;
  try {
    if (msg.type === 'image') {
      text = `[รูป] ${await describeImage(await downloadContent(msg.id))}`;
    } else if (msg.type === 'audio') {
      text = `[เสียงพูด] ${await transcribeAudio(await downloadContent(msg.id), msg.id)}`;
    } else if (msg.type === 'video') {
      text = `[วิดีโอ] ${await describeVideo(await downloadContent(msg.id), msg.id)}`;
    } else if (msg.type === 'file') {
      const body = await readFileContent(msg.fileName || '', await downloadContent(msg.id));
      if (body) text = `[ไฟล์ ${msg.fileName}] ${body}`;
    }
  } catch (e) {
    console.error(`[media] ${msg.type} ${msg.id}:`, e.message);
    return; // อ่านไม่ได้ก็ปล่อย placeholder เดิมไว้
  }
  if (!text) return;
  updateMessageText(rowId, text);
  // คำอธิบาย/ข้อความที่ถอดได้ อาจมียอดเงิน (เช่นสลิป) → ดักจับต่อเลย
  for (const v of extractMoney(text)) logExtract(groupId, rowId, 'money', v);
  console.log(`[media] อ่าน ${msg.type} สำเร็จ (${text.length} ตัวอักษร)`);

  // กลุ่มที่เปิด !อ่านรูป → ตอบสรุปเข้ากลุ่มทันที (reply ฟรี — token อายุ ~1 นาที ปกติอ่านรูปทัน หมดอายุก็แค่เงียบ log ยังอยู่)
  // ตอบเป็นการ์ด Flex กรอบเดียวกับคำตอบอื่น (user เคาะ 2026-08-25: เอาแบบกล่อง อ่านง่าย)
  if (msg.type === 'image' && replyCtx?.replyToken && getGroup(groupId)?.image_reply) {
    const body = text.replace(/^\[รูป\]\s*/, '');
    await replyCtx.client
      .replyMessage({
        replyToken: replyCtx.replyToken,
        messages: [
          proseCard({
            title: `📷 ${SELF}อ่านรูปให้แล้วค่ะ`,
            prose: body,
            footerText: 'ถามต่อจากรูปได้ด้วย !ถาม · ปิดโหมดนี้พิมพ์ !อ่านรูป ปิด',
          }),
        ],
      })
      .catch((e) => console.error('[media] ตอบสรุปรูปไม่สำเร็จ:', e.message));
  }
}

module.exports = { processMedia };
