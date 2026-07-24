// ดักจับยอดเงินจากข้อความแบบเรียลไทม์ (regex เบาๆ ไม่เปลือง AI)
// จับ: "1,500 บาท" "500บ." "฿250" "โอน 500" "ยอด 1200" — ใช้ทั้งข้อความแชทและข้อความที่ AI ถอดจากรูป/เสียง
const MONEY_RE = /(?:฿\s*([\d,]+(?:\.\d{1,2})?))|([\d,]+(?:\.\d{1,2})?)\s*(?:บาท|บ\.)|(?:โอน|ยอด|ราคา|ค่า(?:ส่ง|มัดจำ)?)\s*([\d,]+(?:\.\d{1,2})?)/g;

function extractMoney(text) {
  const found = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const num = m[1] || m[2] || m[3];
    if (!num) continue;
    const val = parseFloat(num.replace(/,/g, ''));
    if (val >= 1 && val <= 100_000_000) found.push(`${num} บาท`);
  }
  return found;
}

module.exports = { extractMoney };
