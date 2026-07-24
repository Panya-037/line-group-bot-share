// การ์ด Flex ทั้งหมดของน้องฟ้าใส — โทนฟ้า-ขาว คลีนๆ (เข้ากับชื่อฟ้าใส)
// หมายเหตุต้นทุน: Flex = แค่เลย์เอาต์ห่อข้อความเดิม ไม่เรียก AI เพิ่ม + ตอบในกลุ่มด้วย reply = ฟรี
const dayjs = require('./time');

const SKY = '#3f9fda'; // หัวการ์ด — ฟ้าใสสดแต่ไม่จัด
const SKY_DARK = '#1f7ac0'; // ตัวหนังสือหัวข้อ/ตัวเลขเด่น — ฟ้าเข้มอ่านชัดบนขาว
const SKY_SOFT = '#f4fafe'; // พื้นหลังเนื้อหา — เกือบขาว อมฟ้านิดเดียว คลีน
const SKY_SUB = '#dceffb'; // ตัวหนังสือรองบนหัวฟ้า — ฟ้าอ่อนมาก
const DARK = '#213648'; // ตัวหนังสือหลัก — น้ำเงินเข้ม (navy)
const MUTED = '#8399a8'; // ตัวหนังสือรอง — เทาอมฟ้า
const LINE_SOFT = '#dbeaf6'; // เส้นคั่น — ฟ้าจาง

const t = (text, extra = {}) => ({ type: 'text', text: String(text || '-'), wrap: true, ...extra });

// วันที่แบบไทย พ.ศ. จาก 'YYYY-MM-DD' เช่น "จ. 24 ก.ค. 2569" (ไว้โชว์บนหัวการ์ดสรุป)
function thaiDate(dateStr) {
  const d = dayjs(dateStr);
  if (!d.isValid()) return '';
  return `${d.format('dd D MMM')} ${d.year() + 543}`;
}
// subtitle หัวการ์ดสรุป: วันที่ + ชื่อกลุ่ม (ไม่มีวันที่ก็โชว์แค่กลุ่ม)
function summarySubtitle(dateStr, groupName) {
  const day = thaiDate(dateStr);
  return day ? `${day} · ${groupName}` : groupName;
}

// โครงการ์ดมาตรฐาน: หัวสีฟ้า + เนื้อหาในกล่องขาวอมฟ้า + ฟุตเตอร์ (ทางเลือก)
function bubble({ title, subtitle, bodyContents, footerText, altText }) {
  const b = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: SKY,
      paddingAll: 'lg',
      contents: [
        t(title, { size: 'lg', weight: 'bold', color: '#ffffff' }),
        ...(subtitle ? [t(subtitle, { size: 'xs', color: SKY_SUB })] : []),
      ],
    },
    body: { type: 'box', layout: 'vertical', backgroundColor: SKY_SOFT, paddingAll: 'lg', spacing: 'xs', contents: bodyContents },
  };
  if (footerText) {
    b.footer = {
      type: 'box',
      layout: 'vertical',
      backgroundColor: SKY_SOFT,
      paddingAll: 'md',
      contents: [t(footerText, { size: 'xxs', color: MUTED, align: 'center' })],
    };
  }
  return { type: 'flex', altText: (altText || title).slice(0, 390), contents: b };
}

// แปลงข้อความหลายบรรทัดเป็น content — บรรทัดที่ขึ้นต้นด้วยอิโมจิหัวข้อทำเป็นตัวหนา เว้นวรรคก่อนหัวข้อ
const HEADER_EMOJIS = ['📌', '✅', '💰', '⏳', '📊', '🗓️', '📋', '💬', '🔍', '💡', '📝'];
function proseToContents(prose) {
  const out = [];
  let first = true;
  for (const raw of String(prose).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue; // ข้ามบรรทัดว่าง ใช้ margin จัดระยะแทน
    const isHeader = HEADER_EMOJIS.some((e) => line.startsWith(e));
    out.push(
      t(line, {
        size: 'sm',
        color: isHeader ? SKY_DARK : DARK,
        weight: isHeader ? 'bold' : 'regular',
        margin: isHeader && !first ? 'lg' : first ? 'none' : 'sm',
      }),
    );
    first = false;
  }
  return out.length ? out : [t('-', { size: 'sm', color: MUTED })];
}

// แถวตาราง 3 คอลัมน์: งาน | ใคร | กำหนด
function taskRow({ task, owner, due }, isHeader = false) {
  const color = isHeader ? MUTED : DARK;
  const size = isHeader ? 'xxs' : 'sm';
  const weight = isHeader ? 'bold' : 'regular';
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      t(task, { flex: 5, size, color, weight }),
      t(owner, { flex: 3, size, color, weight }),
      t(due, { flex: 3, size, color, weight }),
    ],
  };
}

function section(emoji, title, lines) {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    spacing: 'xs',
    contents: [
      t(`${emoji} ${title}`, { size: 'xs', color: MUTED, weight: 'bold' }),
      ...lines.map((l) => t(`• ${l}`, { size: 'sm', color: DARK })),
    ],
  };
}

// data = ผลจาก extractWorkItems: {tasks, money, pending}
function workSummaryFlex({ groupName, dateLabel, dateStr, tasks, money, pending }) {
  const MAX_ROWS = 10;
  const shown = tasks.slice(0, MAX_ROWS);
  const dropped = tasks.length - shown.length;

  const body = [];
  if (shown.length) {
    body.push(taskRow({ task: 'งาน', owner: 'ใคร', due: 'กำหนด' }, true));
    body.push({ type: 'separator', color: LINE_SOFT });
    for (const task of shown) {
      body.push(taskRow(task));
      body.push({ type: 'separator', color: LINE_SOFT });
    }
    body.pop(); // separator ตัวสุดท้ายไม่ต้อง
    if (dropped > 0) body.push(t(`…และอีก ${dropped} งาน (พิมพ์ !สรุป ดูเต็มๆ)`, { size: 'xxs', color: MUTED, margin: 'sm' }));
  }
  if (money.length) {
    body.push(section('💰', 'เงินที่พูดถึง', money.slice(0, 6).map((moneyItem) => `${moneyItem.item} — ${moneyItem.amount}`)));
  }
  if (pending.length) {
    body.push(section('⏳', 'ค้างคำตอบ ต้องตามต่อ', pending.slice(0, 5)));
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: SKY,
      paddingAll: 'lg',
      contents: [
        t(`📋 สรุปงาน${dateLabel}`, { size: 'lg', weight: 'bold', color: '#ffffff' }),
        t(summarySubtitle(dateStr, groupName), { size: 'xs', color: SKY_SUB }),
      ],
    },
    body: { type: 'box', layout: 'vertical', backgroundColor: SKY_SOFT, paddingAll: 'lg', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: SKY_SOFT,
      paddingAll: 'md',
      contents: [t('น้องคัดเฉพาะเรื่องงานมาให้แล้วนะคะ อยากอ่านละเอียดพิมพ์ !สรุป ได้เลยค่ะ 💙', { size: 'xxs', color: MUTED, align: 'center' })],
    },
  };

  return {
    type: 'flex',
    altText: `📋 สรุปงาน${dateLabel} — งาน ${tasks.length} รายการ`,
    contents: bubble,
  };
}

// ---------- การ์ดคำตอบทั่วไป (ใช้กับ !สรุป / !ถาม / mention) ----------

// สรุปแชทแบบร้อยแก้ว (จาก summarizeChat) ใส่การ์ด — ส่ง dateStr มาจะโชว์วันที่ + กลุ่มบนหัว
function proseCard({ title, subtitle, dateStr, groupName, prose, footerText }) {
  const sub = subtitle ?? (groupName ? summarySubtitle(dateStr, groupName) : undefined);
  return bubble({ title, subtitle: sub, bodyContents: proseToContents(prose), footerText, altText: `${title}\n${prose}` });
}

// คำตอบจากการถาม AI — โชว์คำถามจางๆ ด้านบน แล้วคำตอบ
function answerCard(question, answer) {
  const body = [
    t(`❔ ${question}`, { size: 'xs', color: MUTED }),
    { type: 'separator', color: LINE_SOFT, margin: 'md' },
    ...proseToContents(answer).map((c, i) => (i === 0 ? { ...c, margin: 'md' } : c)),
  ];
  return bubble({ title: '💬 น้องฟ้าใสตอบ', bodyContents: body, altText: `น้องฟ้าใสตอบ: ${answer}` });
}

// ---------- การ์ดผลค้นหา ----------
function searchFlex(term, rows) {
  const body = rows.map((m, i) => ({
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    margin: i === 0 ? 'none' : 'lg',
    contents: [
      t(`${dayjs.utc(m.ts).tz().format('D MMM · HH:mm')} · ${m.name}`, { size: 'xxs', color: MUTED }),
      t(clip(m.text, 140), { size: 'sm', color: DARK }),
    ],
  }));
  return bubble({
    title: '🔍 ผลค้นหา',
    subtitle: `"${term}" — ${rows.length} รายการล่าสุด`,
    bodyContents: body,
    footerText: 'อยากอ่านบริบทเต็มๆ พิมพ์ !สรุป ได้เลยค่ะ',
    altText: `ผลค้นหา "${term}" ${rows.length} รายการ`,
  });
}

// ---------- การ์ดยอดเงินวันนี้ ----------
function moneyFlex(dateLabel, rows) {
  const body = rows.map((e, i) => ({
    type: 'box',
    layout: 'horizontal',
    margin: i === 0 ? 'none' : 'md',
    spacing: 'sm',
    contents: [
      t(`${dayjs.utc(e.ts).tz().format('HH:mm')} · ${e.name}`, { size: 'xs', color: MUTED, flex: 5 }),
      t(e.value, { size: 'sm', color: SKY_DARK, weight: 'bold', flex: 4, align: 'end' }),
    ],
  }));
  return bubble({
    title: `💰 ยอดเงิน${dateLabel}`,
    subtitle: `เจอ ${rows.length} รายการ`,
    bodyContents: body,
    footerText: 'น้องจับให้อัตโนมัติจากข้อความ+สลิปนะคะ อยากได้บริบทพิมพ์ !สรุป',
    altText: `ยอดเงิน${dateLabel} ${rows.length} รายการ`,
  });
}

// ---------- การ์ดวิธีใช้ ----------
function helpFlex(hour) {
  const cmds = [
    ['!สรุป', 'สรุปแชทวันนี้ (เมื่อวาน: !สรุปเมื่อวาน)'],
    ['!ค้น <คำ>', 'ค้นข้อความย้อนหลัง'],
    ['!ถาม <คำถาม>', 'ถามจากประวัติแชท (หรือ @ เราแล้วถาม)'],
    ['!ยอดเงิน', 'ตัวเลขเงินที่จับได้วันนี้'],
    ['!สรุปอัตโนมัติ เปิด/ปิด', 'สรุปงานรายวันอัตโนมัติ'],
    ['!เวลาสรุป <0-23>', `ตั้งเวลาสรุป (ตอนนี้ ${hour}:00 น.)`],
  ];
  const body = [
    t('น้องช่วยเก็บแชทให้ค้นย้อนหลัง สรุปงานให้ทุกวัน รูป/สลิป/เสียง/ไฟล์ก็อ่านให้หมดเลยค่ะ 💙', { size: 'sm', color: DARK }),
    { type: 'separator', color: LINE_SOFT, margin: 'lg' },
    ...cmds.map(([cmd, desc], i) => ({
      type: 'box',
      layout: 'vertical',
      spacing: 'none',
      margin: i === 0 ? 'lg' : 'md',
      contents: [t(cmd, { size: 'sm', color: SKY_DARK, weight: 'bold' }), t(desc, { size: 'xs', color: MUTED })],
    })),
  ];
  return bubble({
    title: '📖 น้องฟ้าใสทำอะไรได้บ้าง',
    bodyContents: body,
    footerText: 'น้องเห็นเฉพาะข้อความหลังเข้ากลุ่มนะคะ ย้อนก่อนหน้าไม่ได้ค่ะ',
    altText: 'วิธีใช้น้องฟ้าใส',
  });
}

// ---------- การ์ดแนะนำตัวตอนเข้ากลุ่ม ----------
function welcomeFlex() {
  const body = [
    t('น้องฟ้าใสเป็นบอทผู้ช่วยประจำกลุ่มค่ะ ฝากเนื้อฝากตัวด้วยนะคะ 💙', { size: 'sm', color: DARK }),
    t('ต่อจากนี้น้องขอช่วยจดแชท สรุปงานให้ทุกวัน ใครอยากค้นเรื่องเก่าหรือถามอะไรย้อนหลัง ทักน้องได้เลยค่ะ', { size: 'sm', color: DARK, margin: 'md' }),
    t('รูป สลิป เสียงพูด ไฟล์ ส่งมาได้เลยนะคะ น้องอ่านให้หมด 🖼️🎤📄', { size: 'sm', color: DARK, margin: 'md' }),
    { type: 'separator', color: LINE_SOFT, margin: 'lg' },
    t('พิมพ์ !ช่วย เพื่อดูว่าน้องทำอะไรได้บ้างค่ะ', { size: 'sm', color: SKY_DARK, weight: 'bold', margin: 'lg' }),
  ];
  return bubble({
    title: '💙 สวัสดีค่ะ น้องฟ้าใสมาแล้ว',
    subtitle: 'บอทผู้ช่วยประจำกลุ่ม',
    bodyContents: body,
    footerText: 'น้องเห็นเฉพาะข้อความหลังจากนี้นะคะ ย้อนก่อนหน้าไม่ได้ค่ะ 🙏',
    altText: 'สวัสดีค่ะ น้องฟ้าใส บอทผู้ช่วยประจำกลุ่ม ฝากเนื้อฝากตัวด้วยนะคะ พิมพ์ !ช่วย ดูคำสั่ง',
  });
}

// ตัวหนังสือธรรมดาไว้ส่งสำเนา Telegram
function workSummaryText({ groupName, dateLabel, dateStr, tasks, money, pending }) {
  const day = thaiDate(dateStr);
  const out = [`📋 สรุปงาน${dateLabel}${day ? ` (${day})` : ''} — ${groupName}`];
  if (tasks.length) {
    out.push('', ...tasks.map((x, i) => `${i + 1}. ${x.task} — ${x.owner || '-'} (${x.due || '-'})`));
  }
  if (money.length) out.push('', '💰 ' + money.map((x) => `${x.item} ${x.amount}`).join(' / '));
  if (pending.length) out.push('', '⏳ ' + pending.join(' / '));
  return out.join('\n');
}

function clip(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
}

module.exports = {
  workSummaryFlex,
  workSummaryText,
  proseCard,
  answerCard,
  searchFlex,
  moneyFlex,
  helpFlex,
  welcomeFlex,
};
