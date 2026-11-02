// บรีฟสรุป — "ให้สรุปอะไรบ้าง / ไม่ต้องสรุปอะไร" ตั้งโดยผู้ดูแลระบบ (คนส่งมอบบอท) ไม่ใช่สมาชิกในกลุ่ม
//
//   SUMMARY_FOCUS=เน้นออเดอร์ลูกค้า ยอดโอน สถานะจัดส่ง ปัญหาร้องเรียน · ไม่ต้องสรุปเรื่องส่วนตัว
//     → ทุกการสรุป (การ์ดรายวัน / !สรุป / งานที่ต้องทำ / หน้าภาพรวม) และคำตอบ !ถาม ยึดคำสั่งนี้
//
//   บรีฟยาวหลายบรรทัด เขียนในไฟล์ brief.txt (ข้างๆ package.json) แทน — มีไฟล์ระบบอ่านเอง
//   หรือชี้ไฟล์อื่นด้วย SUMMARY_FOCUS_FILE=./brief-shop.txt · ตั้งทั้งคู่ = SUMMARY_FOCUS ใน .env ชนะ
//
// ไม่ตั้งอะไรเลย = สรุปแบบทั่วไป (งาน/นัด/เงิน/เรื่องค้าง) prompt เดิมไม่เปลี่ยนแม้แต่ตัวเดียว
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHARS = 1500; // กันบรีฟยาวจนกิน prompt — เกินตัดท้ายแล้วเตือนใน log
const DEFAULT_FILE = path.join(__dirname, '..', 'brief.txt');

function readBriefFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return ''; // ไม่มีไฟล์ = ไม่มีบรีฟ
  }
}

// ตัดบรรทัดหมายเหตุ (#) กับบรรทัดว่างเกิน — ไฟล์ brief.txt จะได้จดโน้ตให้ตัวเองได้โดยไม่ส่งให้ AI
function clean(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// แยกเป็นฟังก์ชันบริสุทธิ์ (รับ env + ตัวอ่านไฟล์) ให้เทสเรียกได้โดยไม่ยุ่ง process.env / ดิสก์จริง
function resolve(env = {}, { readFile = readBriefFile } = {}) {
  let source = 'none';
  let text = clean(env.SUMMARY_FOCUS);
  if (text) source = 'env';
  else {
    const file = String(env.SUMMARY_FOCUS_FILE || '').trim() || DEFAULT_FILE;
    text = clean(readFile(file));
    if (text) source = 'file';
  }
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS).trim();
    truncated = true;
  }
  return {
    FOCUS: text,
    SOURCE: source, // 'env' | 'file' | 'none'
    TRUNCATED: truncated,
    // ลายเซ็นสั้นๆ ของบรีฟ — แคชผล AI (work_items / digests) จำไว้ว่าสรุปด้วยบรีฟไหน เปลี่ยนบรีฟ = สรุปใหม่
    KEY: text ? crypto.createHash('sha1').update(text).digest('hex').slice(0, 10) : '',
    // ก้อนข้อความไว้ต่อท้าย system prompt ของ AI ทุกตัว — ไม่มีบรีฟ = สตริงว่าง ไม่แตะ prompt เดิม
    block: () =>
      text
        ? `\n\nคำสั่งจากผู้ดูแลระบบ — เรื่องที่ต้องเก็บ/ตัด ให้ยึดตามนี้เสมอ (รูปแบบคำตอบคงตามโครงด้านบน):\n${text}`
        : '',
  };
}

const current = resolve(process.env);
if (current.TRUNCATED) console.warn(`⚠️  บรีฟสรุปยาวเกิน ${MAX_CHARS} ตัวอักษร — ตัดส่วนท้ายทิ้ง`);

module.exports = { ...current, resolve, clean, MAX_CHARS, DEFAULT_FILE };
