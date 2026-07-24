// seed-mock.js — ใส่ข้อมูลจำลองลง DB เพื่อดูแดชบอร์ด/ทดลองเล่นได้ทันที (ไม่ต้องมีกลุ่มไลน์จริง)
// วิธีใช้:  node scripts/seed-mock.js   แล้ว  npm start  →  เปิด /admin?key=<ADMIN_KEY>
//
// ข้อมูลทั้งหมดเป็นชื่อ/ยอด/ข้อความสมมติ ไม่เกี่ยวกับกลุ่มจริงใครทั้งสิ้น
require('dotenv').config();
const dayjs = require('../src/time');
const { db, ensureGroup, setGroupName, upsertMember, logMessage, logExtract, setSummaryHour } = require('../src/db');

// ล้างข้อมูลเดิมก่อน seed (กันซ้ำเวลารันหลายรอบ)
for (const tbl of ['extracts', 'messages', 'members', 'groups', 'pushes']) db.prepare(`DELETE FROM ${tbl}`).run();

// แทรกข้อความพร้อมเวลาย้อนหลังตามต้องการ (dayOffset วันก่อน, hh = ชั่วโมงไทย)
function seedMsg(gid, uid, type, text, dayOffset, hh) {
  const utcHour = String((hh - 7 + 24) % 24).padStart(2, '0'); // เวลาไทย → UTC
  const day = dayjs().subtract(dayOffset, 'day').format('YYYY-MM-DD');
  const info = db
    .prepare(`INSERT INTO messages (group_id,user_id,line_msg_id,type,text,ts) VALUES (?,?,?,?,?,?)`)
    .run(gid, uid, `mock-${gid}-${dayOffset}-${hh}-${Math.round(hh * 97 + dayOffset)}`, type, text, `${day} ${utcHour}:00:00`);
  return info.lastInsertRowid;
}

// ---- กลุ่มที่ 1: ทีมงานภายใน ----
ensureGroup('Gmock-team');
setGroupName('Gmock-team', 'ทีมงานร้าน (ตัวอย่าง)');
setSummaryHour('Gmock-team', 20);
upsertMember('Gmock-team', 'Umock-a', 'พลอย');
upsertMember('Gmock-team', 'Umock-b', 'ต้น');
upsertMember('Gmock-team', 'Umock-c', 'แนน');

// ---- กลุ่มที่ 2: คุยกับลูกค้า ----
ensureGroup('Gmock-cust');
setGroupName('Gmock-cust', 'ออเดอร์ลูกค้า (ตัวอย่าง)');
setSummaryHour('Gmock-cust', 20);
upsertMember('Gmock-cust', 'Umock-d', 'คุณเอ');
upsertMember('Gmock-cust', 'Umock-e', 'แอดมิน');

// วันนี้ (offset 0) — ทีมงาน: งานปนคุยเล่น + สื่อหลายแบบ
seedMsg('Gmock-team', 'Umock-a', 'text', 'อรุณสวัสดิ์ค่า วันนี้ประชุมกี่โมงนะ', 0, 9);
seedMsg('Gmock-team', 'Umock-b', 'text', 'บ่าย 2 นะ ห้องประชุมชั้น 3 พลอยเตรียมสไลด์ด้วย', 0, 9);
seedMsg('Gmock-team', 'Umock-a', 'text', 'รับทราบ เดี๋ยวส่งดราฟต์ก่อนเที่ยง', 0, 10);
seedMsg('Gmock-team', 'Umock-c', 'image', '[รูป] ตัวอย่างแพ็กเกจสินค้าใหม่ สีพาสเทล 3 โทน', 0, 10);
seedMsg('Gmock-team', 'Umock-b', 'text', 'สวยงาม 555 เอาโทนฟ้าเลย', 0, 11);
seedMsg('Gmock-team', 'Umock-c', 'audio', '[เสียงพูด] ฝากสั่งกล่องเพิ่ม 200 ใบด้วยนะ', 0, 11);
seedMsg('Gmock-team', 'Umock-a', 'file', '[ไฟล์ ใบเสนอราคาโรงพิมพ์.pdf] ค่ากล่อง 200 ใบ 3,400 บาท ส่งภายใน 5 วัน', 0, 13);
const t1 = seedMsg('Gmock-team', 'Umock-b', 'text', 'โอเค เดี๋ยวโอนมัดจำ 1,700 บาท ให้โรงพิมพ์ก่อน', 0, 14);
logExtract('Gmock-team', t1, 'money', '1,700 บาท');
seedMsg('Gmock-team', 'Umock-c', 'sticker', '[สติกเกอร์]', 0, 14);

// วันนี้ — ลูกค้า: ยอดโอน + สลิป
seedMsg('Gmock-cust', 'Umock-d', 'text', 'สนใจเซ็ตนี้ค่ะ ยอดเท่าไหร่คะ', 0, 12);
seedMsg('Gmock-cust', 'Umock-e', 'text', 'เซ็ตนี้ 1,250 บาทค่ะ ส่งฟรี', 0, 12);
const c1 = seedMsg('Gmock-cust', 'Umock-d', 'image', '[รูป] สลิปโอนเงิน ธนาคาร · 1,250.00 บาท · 12:45 น.', 0, 12);
logExtract('Gmock-cust', c1, 'money', '1,250 บาท');
seedMsg('Gmock-cust', 'Umock-e', 'text', 'ได้รับยอดแล้วค่ะ เดี๋ยวจัดส่งพรุ่งนี้', 0, 13);

// เมื่อวาน (offset 1) — ให้ delta ของแดชบอร์ดมีตัวเลขเทียบ
for (let i = 0; i < 5; i++) seedMsg('Gmock-team', 'Umock-a', 'text', `คุยงานเมื่อวาน #${i + 1}`, 1, 10 + i);
for (let i = 0; i < 3; i++) seedMsg('Gmock-cust', 'Umock-d', 'text', `สอบถามเมื่อวาน #${i + 1}`, 1, 14 + i);

// ย้อน 2–13 วัน — ให้กราฟ 14 วันมีแท่งหลากหลาย
for (let d = 2; d <= 13; d++) {
  const n = 2 + ((d * 7) % 9); // จำนวนสุ่มแบบ deterministic
  for (let i = 0; i < n; i++) seedMsg('Gmock-team', 'Umock-b', 'text', `ข้อความย้อนหลังวัน -${d} #${i + 1}`, d, 9 + (i % 8));
}

const total = db.prepare(`SELECT count(*) c FROM messages`).get().c;
console.log(`✅ ใส่ข้อมูลจำลองแล้ว: 2 กลุ่ม, ${total} ข้อความ`);
console.log(`   รัน  npm start  แล้วเปิด  http://localhost:${process.env.PORT || 3000}/admin?key=${process.env.ADMIN_KEY || '<ADMIN_KEY>'}`);
