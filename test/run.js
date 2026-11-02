// ชุดทดสอบแบบ offline — ไม่ต้องมี LINE token หรือ OpenRouter key (รันใน CI ได้เลย)
// ครอบคลุม: ชื่อ/ธีมบอทจาก .env, บรีฟสรุป (SUMMARY_FOCUS), db, ดักจับยอดเงิน, mention, คำสั่งที่ไม่เรียก AI,
//          โครงการ์ด Flex, งานที่ต้องทำ (cache ไม่เรียก AI ซ้ำ), แดชบอร์ด + ฟิลเตอร์
const os = require('os');
const path = require('path');
const fs = require('fs');

// ใช้ DB ชั่วคราวแยกต่อการรัน 1 ครั้ง
process.env.DB_PATH = path.join(os.tmpdir(), `groupbot-test-${process.pid}.db`);
process.env.ADMIN_KEY = 'test-key';
// ตั้งชื่อ+ธีมเองเหมือนลูกค้าทำใน .env (ต้องตั้งก่อน require เพราะ branding อ่านตอนโหลด)
process.env.BOT_NAME = 'น้องมะลิ';
process.env.BOT_THEME = 'green';
// บรีฟสรุปที่ผู้ดูแลตั้ง — ต้องไปโผล่ใน prompt ทุกตัว + แดชบอร์ด
process.env.SUMMARY_FOCUS = 'เน้นออเดอร์และยอดโอน ไม่ต้องสรุปเรื่องส่วนตัว';
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const dayjs = require('../src/time');
const db = require('../src/db');
const { extractMoney } = require('../src/extract');
const { handleCommand } = require('../src/commands');
const flex = require('../src/flex');
const { renderDashboard, renderReport, renderOverview, overviewDate, parseFilters } = require('../src/dashboard');
const branding = require('../src/branding');
const brief = require('../src/brief');
const { prompts } = require('../src/ai');
const { collectWork, workItemsFor, cacheFresh } = require('../src/tasks');

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

  // ===== ชื่อบอท/ธีม ตั้งเองจาก .env =====
  check('ชื่อบอทมาจาก BOT_NAME', branding.BOT === 'น้องมะลิ');
  check('เดาคำแทนตัวจากชื่อ: น้องมะลิ → น้อง', branding.SELF === 'น้อง');
  check('ธีมเปลี่ยนตาม BOT_THEME', branding.THEME.main === branding.THEMES.green.main);
  check('ไม่ตั้งอะไรเลย = น้องฟ้าใส ธีมฟ้า', (() => { const b = branding.resolve({}); return b.BOT === 'น้องฟ้าใส' && b.THEME_KEY === 'sky'; })());
  check('ชื่อขึ้นต้น พี่ → เรียกตัวเองว่า พี่', branding.guessSelf('พี่หมี') === 'พี่');
  check('ชื่อฝรั่ง → เรียกชื่อตัวเองเต็ม', branding.guessSelf('MayBot') === 'MayBot');
  check('BOT_SELF สั่งทับได้', branding.resolve({ BOT_NAME: 'น้องมะลิ', BOT_SELF: 'มะลิ' }).SELF === 'มะลิ');
  check('ธีมมั่ว → ถอยไปใช้ฟ้า', branding.resolve({ BOT_THEME: 'ไม่มีสีนี้' }).THEME_KEY === 'sky');
  check('BOT_POLITE=ชาย → ลงท้ายครับ', branding.toMale('สวัสดีค่ะ ฝากตัวด้วยนะคะ') === 'สวัสดีครับ ฝากตัวด้วยนะครับ');
  check('BOT_POLITE=ชาย ไม่ทำคำว่าคะแนนพัง', branding.toMale('ได้ 5 คะแนนค่ะ') === 'ได้ 5 คะแนนครับ');
  check('ค่าเริ่มต้น (หญิง) ไม่แตะข้อความ', branding.resolve({}).say('สวัสดีค่ะ') === 'สวัสดีค่ะ');
  check('การ์ดใช้ชื่อที่ตั้งเอง', cards.helpFlex.contents.header.contents[0].text.includes('น้องมะลิ'));
  check('การ์ดต้อนรับใช้ชื่อที่ตั้งเอง', cards.welcomeFlex.altText.includes('น้องมะลิ'));
  check('การ์ดใช้สีตามธีมที่ตั้ง', cards.helpFlex.contents.header.backgroundColor === branding.THEMES.green.main);

  // ===== บรีฟสรุป — ผู้ดูแลสั่งว่าให้สรุปอะไรบ้าง =====
  check('บรีฟมาจาก SUMMARY_FOCUS', brief.SOURCE === 'env' && brief.FOCUS.includes('ออเดอร์') && brief.KEY.length === 10);
  check('ไม่ตั้งอะไรเลย = ไม่มีบรีฟ ไม่แตะ prompt', (() => { const b = brief.resolve({}, { readFile: () => '' }); return b.SOURCE === 'none' && b.block() === '' && b.KEY === ''; })());
  check('อ่านบรีฟจากไฟล์ได้ + ข้ามบรรทัด #', (() => { const b = brief.resolve({}, { readFile: () => '# หมายเหตุ\nเน้นงานก่อสร้าง\n\n\n- ตามใบเสนอราคา\n' }); return b.SOURCE === 'file' && b.FOCUS === 'เน้นงานก่อสร้าง\n\n- ตามใบเสนอราคา'; })());
  check('.env ชนะไฟล์', brief.resolve({ SUMMARY_FOCUS: 'จาก env' }, { readFile: () => 'จากไฟล์' }).FOCUS === 'จาก env');
  check('SUMMARY_FOCUS_FILE ชี้ไฟล์อื่นได้', (() => { let seen = null; brief.resolve({ SUMMARY_FOCUS_FILE: './x.txt' }, { readFile: (f) => { seen = f; return 'ok'; } }); return seen === './x.txt'; })());
  check('ไม่ชี้ไฟล์ = อ่าน brief.txt ข้าง package.json', (() => { let seen = null; brief.resolve({}, { readFile: (f) => { seen = f; return ''; } }); return seen === brief.DEFAULT_FILE; })());
  check('บรีฟยาวเกินถูกตัด', (() => { const b = brief.resolve({ SUMMARY_FOCUS: 'ก'.repeat(brief.MAX_CHARS + 50) }); return b.TRUNCATED && b.FOCUS.length === brief.MAX_CHARS; })());
  check('บรีฟต่างกัน = KEY ต่างกัน', brief.resolve({ SUMMARY_FOCUS: 'ก' }).KEY !== brief.resolve({ SUMMARY_FOCUS: 'ข' }).KEY);
  check('prompt สรุปทุกตัวมีบรีฟต่อท้าย', ['summarize', 'work', 'digest'].every((k) => prompts[k]().includes('เน้นออเดอร์และยอดโอน')));
  check('prompt ตอบคำถามมีบรีฟด้วย', prompts.answer('กลุ่มทดสอบ').includes('เน้นออเดอร์และยอดโอน') && prompts.answer('กลุ่มทดสอบ').includes('น้องมะลิ'));
  check('ไม่มีบรีฟ = prompt เดิม ไม่มีก้อนคำสั่ง', !prompts.work('').includes('คำสั่งจากผู้ดูแลระบบ') && !prompts.summarize('').includes('คำสั่งจากผู้ดูแลระบบ'));
  check('บรีฟไม่ทำโครง JSON หาย', prompts.work().includes('"tasks"') && prompts.digest().includes('"headline"'));

  // ===== งานที่ต้องทำ — ต้องไม่เรียก AI ซ้ำถ้าไม่มีข้อความใหม่ =====
  const today = dayjs().format('YYYY-MM-DD');
  db.ensureGroup('G2');
  db.setGroupName('G2', 'กลุ่มงาน');
  for (const [i, txt] of ['ทำสไลด์ให้หน่อย', 'ได้เลย พรุ่งนี้เช้า', 'โอนมัดจำ 2,000 บาทแล้ว'].entries()) {
    db.logMessage('G2', 'U1', `wk${i}`, 'text', txt);
  }
  const rowsToday = db.messagesOfDay('G2', today);
  db.saveWorkItems('G2', today, rowsToday[rowsToday.length - 1].id, { tasks: [{ task: 'ทำสไลด์', owner: 'พลอย', due: 'พรุ่งนี้' }], money: [], pending: [] });
  const cachedWork = await workItemsFor('G2', today, { groupName: 'กลุ่มงาน' });
  check('งานที่ cache ไว้ = ไม่เรียก AI', cachedWork.usedAI === false && cachedWork.data.tasks.length === 1);
  check('แคชงานจำบรีฟที่ใช้คัด', db.getWorkItems('G2', today).brief_key === brief.KEY);
  check('เปลี่ยนบรีฟ = แคชเก่าใช้ไม่ได้ ต้องคัดใหม่', cacheFresh({ last_msg_id: 1, brief_key: 'old' }, 1) === false && cacheFresh({ last_msg_id: 1, brief_key: brief.KEY }, 1) === true && cacheFresh({ last_msg_id: 2, brief_key: brief.KEY }, 1) === false);
  db.saveDigest('G2', today, 1, { headline: 'x', topics: [], followups: [] });
  check('แคชภาพรวมจำบรีฟที่ใช้สรุป', db.getDigest('G2', today).brief_key === brief.KEY);
  const collected = await collectWork({ from: today, to: today, groupId: 'G2' });
  check('รวมงานทั้งช่วงได้จาก cache', collected.usedAI === 0 && collected.items[0].tasks[0].task === 'ทำสไลด์');
  db.ensureGroup('G3');
  db.logMessage('G3', 'U1', 'q1', 'text', 'ไปกินข้าวกัน');
  check('แชทเงียบ (<3 ข้อความ) = ไม่เรียก AI', (await workItemsFor('G3', today, {})).quiet === true);

  // ===== แดชบอร์ด =====
  const html = renderDashboard('test-key');
  check('แดชบอร์ดเป็น HTML เต็ม', html.startsWith('<!doctype html>') && html.includes('</html>'));
  check('แดชบอร์ดใช้ชื่อบอทที่ตั้งเอง', html.includes('น้องมะลิ · แดชบอร์ด') && !html.includes('น้องฟ้าใส'));
  check('แดชบอร์ดใช้สีตามธีมที่ตั้ง', html.includes(branding.THEMES.green.main));
  check('แดชบอร์ดมีกราฟ 14 แท่ง', (html.match(/class="bar-col"/g) || []).length === 14);
  check('แดชบอร์ดโชว์กลุ่มทดสอบ', html.includes('กลุ่มทดสอบ'));
  check('แดชบอร์ด escape ปลอดภัย', !/<script>alert/i.test(html));
  check('ลิงก์ backup มี key', html.includes('/admin/backup?key=test-key'));
  check('การ์ดงานที่ต้องทำอยู่บนหน้า', html.includes('งานที่ต้องทำ'));
  check('แดชบอร์ดโชว์บรีฟที่ใช้อยู่ในกล่องข้อมูลระบบ', html.includes('บรีฟสรุป (SUMMARY_FOCUS ใน .env)') && html.includes('เน้นออเดอร์และยอดโอน'));

  // ===== ฟิลเตอร์ช่วง/กลุ่ม =====
  check('ช่วงเริ่มต้น = วันนี้', parseFilters({}).range === 'today');
  check('ช่วง 30 วัน', parseFilters({ range: '30' }).days === 30);
  check('ช่วงมั่ว → ถอยไปวันนี้', parseFilters({ range: 'มั่ว' }).range === 'today');
  check('เลือกกลุ่มได้', parseFilters({ group: 'G2' }).groupId === 'G2');
  const html7 = renderDashboard('test-key', { range: '7' });
  check('ฟิลเตอร์ 7 วัน เรนเดอร์ได้', html7.includes('7 วัน') && html7.includes('range=7'));
  const html30 = renderDashboard('test-key', { range: '30' });
  check('ช่วง 30 วัน = กราฟ 30 แท่ง', (html30.match(/class="bar-col"/g) || []).length === 30);
  const htmlG = renderDashboard('test-key', { group: 'G2' });
  check('เจาะกลุ่มเดียว โชว์ชื่อกลุ่มนั้น', htmlG.includes('กลุ่มงาน'));
  check('ปุ่มช่วงเรียง วันนี้ → 7 → 30', (() => {
    const order = [...html.matchAll(/class="tab[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    return order.indexOf('วันนี้') === 0 && order.indexOf('7 วัน') === 1 && order.indexOf('30 วัน') === 2;
  })());

  // ===== หน้าภาพรวมกลุ่ม /admin/overview =====
  const ovGroups = db.groupsOfDay(today);
  const ovHtml = renderOverview('test-key', {}, ovGroups);
  check('หน้าภาพรวมเป็น HTML เต็ม', ovHtml.startsWith('<!doctype html>') && ovHtml.includes('</html>'));
  check('หน้าภาพรวมใช้ชื่อบอทที่ตั้งเอง', ovHtml.includes('น้องมะลิ · ภาพรวมกลุ่ม'));
  check('หน้าภาพรวมใช้สีตามธีม', ovHtml.includes(branding.THEMES.green.main));
  check('หน้าภาพรวมโชว์การ์ดกลุ่มที่คุยวันนี้', ovHtml.includes('กลุ่มงาน'));
  check('วันที่มั่ว → ถอยกลับมาวันนี้', overviewDate({ date: '2026-02-31' }).date === today);
  check('วันอนาคต → ถอยกลับมาวันนี้', overviewDate({ date: '2099-01-01' }).date === today);
  check('เลือกเมื่อวาน → ป้ายบอก "เมื่อวาน"', overviewDate({ date: dayjs().subtract(1, 'day').format('YYYY-MM-DD') }).label === 'เมื่อวาน');
  check('หน้าภาพรวม escape ปลอดภัย', !/<script>alert/i.test(ovHtml));

  // ===== หน้าอ่านสรุป /admin/report =====
  const rpHtml = renderReport([], 'test-key', today, '');
  check('หน้าอ่านสรุปเรนเดอร์ได้', rpHtml.startsWith('<!doctype html>') && rpHtml.includes('น้องมะลิ · สรุปแชทวันนี้'));

  console.log(`\n${pass} ผ่าน / ${fail} พัง`);
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌ เทสล้ม:', e.stack); process.exit(1); });
