// คำสั่งในกลุ่ม — ตอบด้วย replyToken (ฟรี ไม่กินโควต้า push)
const dayjs = require('./time');
const { SELF, EMOJI } = require('./branding');
const {
  getGroup,
  setSummaryOn,
  setSummaryHour,
  setImageReply,
  messagesOfDay,
  recentMessages,
  searchMessages,
  extractsOfDay,
} = require('./db');
const { summarizeChat, answerQuestion } = require('./ai');
const { proseCard, answerCard, searchFlex, moneyFlex, helpFlex } = require('./flex');

// คืนได้ทั้ง string (→ ห่อเป็นข้อความ), message object (การ์ด Flex), หรือ null = ไม่ใช่คำสั่ง
// คำตอบเนื้อหาเยอะ = การ์ดกรอบสวย / คอนเฟิร์มสั้นๆ = ข้อความธรรมดา (การ์ดจะเวอร์ไป)
async function handleCommand(groupId, groupName, text, mentionQuestion) {
  const t = text.trim();
  const hour = () => getGroup(groupId)?.summary_hour ?? 20;

  // mention บอท → ถือเป็นคำถามทันที
  if (mentionQuestion !== null) {
    const q = mentionQuestion.trim();
    if (!q) return helpFlex(hour());
    const answer = await answerQuestion(recentMessages(groupId, 300), q, { groupName });
    return answerCard(q, answer);
  }

  if (!t.startsWith('!')) return null;

  if (/^!(ช่วย|help)$/i.test(t)) {
    return helpFlex(hour());
  }

  if (t === '!สรุป' || t === '!สรุปวันนี้') {
    return summaryReply(groupId, groupName, dayjs().format('YYYY-MM-DD'), 'วันนี้');
  }
  if (t === '!สรุปเมื่อวาน') {
    return summaryReply(groupId, groupName, dayjs().subtract(1, 'day').format('YYYY-MM-DD'), 'เมื่อวาน');
  }

  const searchM = t.match(/^!ค้น\s+(.+)/s);
  if (searchM) {
    const term = searchM[1].trim();
    const rows = searchMessages(groupId, term, 10);
    if (!rows.length) return `${SELF}หาไม่เจอ "${term}" ในบันทึกเลยค่ะ ลองคำอื่นดูนะคะ 🔍`;
    return searchFlex(term, rows.reverse());
  }

  const askM = t.match(/^!ถาม\s+(.+)/s);
  if (askM) {
    const answer = await answerQuestion(recentMessages(groupId, 300), askM[1].trim(), { groupName });
    return answerCard(askM[1].trim(), answer);
  }

  if (t === '!ยอดเงิน') {
    const today = dayjs().format('YYYY-MM-DD');
    const rows = extractsOfDay(groupId, today).filter((e) => e.kind === 'money');
    if (!rows.length) return `วันนี้${SELF}ยังไม่เจอตัวเลขเงินในแชทเลยค่ะ 💰`;
    return moneyFlex('วันนี้', rows);
  }

  const autoM = t.match(/^!สรุปอัตโนมัติ\s*(เปิด|ปิด)$/);
  if (autoM) {
    const on = autoM[1] === 'เปิด';
    setSummaryOn(groupId, on);
    return on
      ? `เปิดสรุปอัตโนมัติแล้วนะคะ ${SELF}จะสรุปงานให้ทุกวันตอน ${hour()}:00 น. เลยค่ะ ${EMOJI}`
      : `ปิดสรุปอัตโนมัติแล้วค่ะ อยากได้เมื่อไหร่พิมพ์ !สรุป เรียก${SELF}ได้ตลอดนะคะ`;
  }

  const imgM = t.match(/^!อ่านรูป\s*(เปิด|ปิด)$/);
  if (imgM) {
    const on = imgM[1] === 'เปิด';
    setImageReply(groupId, on);
    return on
      ? `เปิดโหมดสรุปรูปทันทีแล้วนะคะ 📷 ต่อจากนี้ส่งรูปมาปุ๊บ ${SELF}อ่านแล้วสรุปตอบในแชทเลยค่ะ`
      : `ปิดโหมดสรุปรูปทันทีแล้วค่ะ ${SELF}ยังอ่านรูปเก็บไว้ให้ค้น/สรุปรายวันเหมือนเดิมนะคะ ${EMOJI}`;
  }

  const hourM = t.match(/^!เวลาสรุป\s+(\d{1,2})$/);
  if (hourM) {
    const h = parseInt(hourM[1], 10);
    if (h < 0 || h > 23) return 'ใส่ชั่วโมง 0-23 นะคะ เช่น !เวลาสรุป 20';
    setSummaryHour(groupId, h);
    return `ตั้งเวลาสรุปรายวันเป็น ${h}:00 น. ให้แล้วนะคะ ⏰`;
  }

  // ขึ้นต้น ! แต่ไม่เข้าเคสไหน → บอกวิธีใช้สั้นๆ
  return `${SELF}ไม่รู้จักคำสั่งนี้ค่ะ ลองพิมพ์ !ช่วย ดูนะคะ`;
}

// !สรุป แบบพิมพ์เอง = สรุปร้อยแก้วละเอียด ใส่การ์ด (เงียบไป → ข้อความสั้น ไม่ต้องการ์ด)
async function summaryReply(groupId, groupName, dateStr, dateLabel) {
  const prose = await summarizeDay(groupId, groupName, dateStr, dateLabel);
  if (prose.includes('😴')) return prose; // วันเงียบ — ข้อความธรรมดาพอ
  return proseCard({
    title: `📝 สรุปแชท${dateLabel}`,
    dateStr,
    groupName,
    prose,
    footerText: 'อยากได้เฉพาะเรื่องงาน รอการ์ดสรุปอัตโนมัติทุก 2 ทุ่มได้เลยนะคะ 💙',
  });
}

// คืน string ร้อยแก้ว (ใช้โดย summaryReply + /admin/summary preview)
async function summarizeDay(groupId, groupName, dateStr, dateLabel) {
  // รวมทุกชนิด (รูป/เสียง/ไฟล์ที่ AI อ่านแล้วด้วย) — ตัดเฉพาะบรรทัดคำสั่ง
  const rows = messagesOfDay(groupId, dateStr).filter((m) => !m.text?.startsWith('!'));
  if (rows.length < 3) return `${dateLabel}แชทเงียบมากๆ เลยค่ะ (${rows.length} ข้อความ) ไม่มีอะไรให้${SELF}สรุปเลย 😴`;
  return summarizeChat(rows, { groupName, dateLabel });
}

module.exports = { handleCommand, summarizeDay };
