// ชุดทดสอบแบบ offline — ไม่ต้องมี LINE token หรือ OpenRouter key (รันใน CI ได้เลย)
// ครอบคลุม: db, ดักจับยอดเงิน, mention, คำสั่งที่ไม่เรียก AI, โครงการ์ด Flex, แดชบอร์ด
const os = require('os');
const path = require('path');
const fs = require('fs');

// ใช้ DB ชั่วคราวแยกต่อการรัน 1 ครั้ง
process.env.DB_PATH = path.join(os.tmpdir(), `groupbot-test-${process.pid}.db`);
process.env.ADMIN_KEY = 'test-key';
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const dayjs = require('../src/time');
const db = require('../src/db');
const { extractMoney } = require('../src/extract');
const { handleCommand } = require('../src/commands');
const flex = require('../src/flex');
const { renderDashboard } = require('../src/dashboard');

let pass = 0, fail = 0;
function check(name, cond) {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}`);
}

// ---------- mirror ของ mentionQuestion ใน index.js (ทดสอบโดยไม่ต้องบูตเซิร์ฟเวอร์) ----------
function mentionQuestion(message, selfId) {
  const men = message.mention?.mentionees || [];
  const mine = men.find((m) => m.isSelf === true || (selfId && m.userId === selfId));
  if (!mine) return null;
  const t = message.text || '';
  return (t.slice(0, mine.index) + t.slice(mine.index + mine.length)).trim();
}

async function main() {
  // ===== db + members + messages =====
  db.ensureGroup('G1');
  db.setGroupName('G1', 'กลุ่มทดสอบ');
  db.upsertMember('G1', 'U1', 'พลอย');
  check('เก็บชื่อกลุ่ม', db.getGroup('G1').name === 'กลุ่มทดสอบ');
  check('เก็บชื่อสมาชิก', db.memberName('G1', 'U1') === 'พลอย');
  check('สมาชิกไม่รู้จัก = ไม่ทราบชื่อ', db.memberName('G1', 'Ux') === 'ไม่ทราบชื่อ');

  db.logMessage('G1', 'U1', 'lm1', 'text', 'พรุ่งนี้ประชุม 10 โมง');
  const paid = db.logMessage('G1', 'U1', 'lm2', 'text', 'โอนแล้ว 1,500 บาท');
  db.logMessage('G1', null, 'lm3', 'image', '[รูป]');
  check('นับข้อความล่าสุด', db.recentMessages('G1').length === 3);
  check('ค้นเจอ', db.searchMessages('G1', 'ประชุม').length === 1);
  check('ค้นด้วย % ไม่พัง', db.searchMessages('G1', '100%').length === 0);
  check('อัพเดตข้อความ (media)', (db.updateMessageText(paid, '[รูป] สลิป 1,500'), db.recentMessages('G1').some((m) => m.text.includes('สลิป'))));
  check('unsend ลบตาม', db.deleteByLineMsgId('lm1') === true);
  check('unsend id มั่ว = false', db.deleteByLineMsgId('nope') === false);

  // ===== ดักจับยอดเงิน =====
  check('เงิน: บาท', JSON.stringify(extractMoney('โอนแล้ว 1,500 บาท')) === JSON.stringify(['1,500 บาท']));
  check('เงิน: ฿', JSON.stringify(extractMoney('ราคา ฿250')) === JSON.stringify(['250 บาท']));
  check('เงิน: โอน+เลข', JSON.stringify(extractMoney('เดี๋ยวโอน 500 ให้')) === JSON.stringify(['500 บาท']));
  check('เงิน: ไม่มี', extractMoney('เจอกัน 10 โมง').length === 0);
  check('เงิน: หลายก้อน', extractMoney('ยอด 1200 กับค่ามัดจำ 300 บาท').length === 2);

  // ===== mention =====
  check('mention: ตัดชื่อบอท', mentionQuestion({ text: '@บอท สรุปให้หน่อย', mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } }, null) === 'สรุปให้หน่อย');
  check('mention: ไม่โดน = null', mentionQuestion({ text: 'ไม่ได้เรียกบอท' }, 'Ubot') === null);

  // ===== คำสั่งที่ไม่เรียก AI =====
  db.logMessage('G1', 'U1', 'lm-search', 'text', 'พรุ่งนี้ประชุมทีม 10 โมง'); // ข้อความไว้ให้ !ค้น เจอ
  check('!ช่วย → การ์ด Flex', (await handleCommand('G1', 'กลุ่มทดสอบ', '!ช่วย', null))?.type === 'flex');
  check('ข้อความธรรมดา → null', (await handleCommand('G1', 'กลุ่มทดสอบ', 'สวัสดี', null)) === null);
  check('!ค้น เจอ → การ์ด Flex', (await handleCommand('G1', 'กลุ่มทดสอบ', '!ค้น ประชุม', null))?.type === 'flex');
  check('!ค้น ไม่เจอ → ข้อความ', typeof (await handleCommand('G1', 'กลุ่มทดสอบ', '!ค้น ไม่มีคำนี้', null)) === 'string');
  const setHour = await handleCommand('G1', 'กลุ่มทดสอบ', '!เวลาสรุป 18', null);
  check('!เวลาสรุป → คอนเฟิร์ม 18:00', typeof setHour === 'string' && setHour.includes('18:00'));
  check('เวลาถูกบันทึก', db.getGroup('G1').summary_hour === 18);
  check('!เวลาสรุป เกินช่วง → เตือน', (await handleCommand('G1', 'กลุ่มทดสอบ', '!เวลาสรุป 30', null)).includes('0-23'));
  check('!สรุปอัตโนมัติ ปิด', (await handleCommand('G1', 'กลุ่มทดสอบ', '!สรุปอัตโนมัติ ปิด', null)).includes('ปิดสรุป'));
  db.setSummaryOn('G1', true);
  check('groupsDueForSummary ตามชั่วโมง', db.groupsDueForSummary(18).length === 1 && db.groupsDueForSummary(9).length === 0);

  // ===== โครงการ์ด Flex ทุกใบ (ไม่เรียก LINE — เช็คโครงสร้าง) =====
  const cards = {
    workSummaryFlex: flex.workSummaryFlex({ groupName: 'ก', dateLabel: 'วันนี้', dateStr: '2026-01-15', tasks: [{ task: 'ทำ A', owner: 'พลอย', due: 'พรุ่งนี้' }], money: [{ item: 'ค่าส่ง', amount: '50 บาท' }], pending: ['ตามใบเสนอราคา'] }),
    proseCard: flex.proseCard({ title: '📝 สรุป', dateStr: '2026-01-15', groupName: 'ก', prose: '📌 หัวข้อ\n• เรื่อง A' }),
    answerCard: flex.answerCard('ถามอะไร', 'ตอบแบบนี้ค่ะ'),
    searchFlex: flex.searchFlex('งาน', [{ ts: '2026-01-15 03:00:00', name: 'พลอย', text: 'งานเสร็จแล้ว' }]),
    moneyFlex: flex.moneyFlex('วันนี้', [{ ts: '2026-01-15 03:00:00', name: 'พลอย', value: '50 บาท' }]),
    helpFlex: flex.helpFlex(20),
    welcomeFlex: flex.welcomeFlex(),
  };
  for (const [name, card] of Object.entries(cards)) {
    const good = card?.type === 'flex' && typeof card.altText === 'string' && card.altText.length > 0 && card.altText.length <= 400 && card.contents?.type === 'bubble' && Array.isArray(card.contents.body?.contents);
    check(`การ์ด ${name} โครงสร้างถูกต้อง`, good);
  }
  check('การ์ดสรุปโชว์วันที่ พ.ศ.', cards.workSummaryFlex.contents.header.contents[1].text.includes('2569'));

  // ===== แดชบอร์ด =====
  const html = renderDashboard('test-key');
  check('แดชบอร์ดเป็น HTML เต็ม', html.startsWith('<!doctype html>') && html.includes('</html>'));
  check('แดชบอร์ดมีชื่อบอท', html.includes('น้องฟ้าใส · แดชบอร์ด'));
  check('แดชบอร์ดมีกราฟ 14 แท่ง', (html.match(/class="bar-col"/g) || []).length === 14);
  check('แดชบอร์ดโชว์กลุ่มทดสอบ', html.includes('กลุ่มทดสอบ'));
  check('แดชบอร์ด escape ปลอดภัย', !/<script>alert/i.test(html));
  check('ลิงก์ backup มี key', html.includes('/admin/backup?key=test-key'));

  console.log(`\n${pass} ผ่าน / ${fail} พัง`);
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌ เทสล้ม:', e.stack); process.exit(1); });
