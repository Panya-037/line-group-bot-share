// ตัวตนของบอท — ชื่อ / คำแทนตัวเอง / อิโมจิ / โทนสี ตั้งได้จาก .env ที่เดียว
//
//   BOT_NAME=น้องมะลิ      → การ์ดในกลุ่ม คำตอบ AI แดชบอร์ด เปลี่ยนชื่อตามทั้งหมด
//   BOT_THEME=pink         → เปลี่ยนโทนสีทั้งระบบ (การ์ด Flex + หน้าแอดมิน)
//   BOT_POLITE=ชาย         → เปลี่ยนคำลงท้ายเป็น ครับ ทั้งบอท
//
// ไฟล์อื่นห้ามฮาร์ดโค้ดชื่อบอทหรือรหัสสีเอง ให้ import จากที่นี่เสมอ

// โทนสีสำเร็จรูป — ชุดเดียวใช้ทั้งการ์ด Flex และหน้าแอดมิน
const THEMES = {
  // ฟ้า-ขาว คลีนๆ (ค่าเริ่มต้น)
  sky: {
    label: 'ฟ้า-ขาว',
    emoji: '💙',
    main: '#3f9fda', // หัวการ์ด / ปุ่ม
    dark: '#1f7ac0', // หัวข้อ ตัวเลขเด่น
    soft: '#f4fafe', // พื้นเนื้อหาการ์ด
    sub: '#dceffb', // ตัวหนังสือรองบนแถบสี
    hair: '#dbeaf6', // เส้นคั่น
    ink: '#213648', // ตัวหนังสือหลัก
    muted: '#8399a8', // ตัวหนังสือรอง
    bg: '#eef5fb', // พื้นหลังหน้าเว็บ
    bg2: '#dceaf6',
    shadowRgb: '31,122,192',
  },
  // ชมพูหวาน
  pink: {
    label: 'ชมพู',
    emoji: '💗',
    main: '#e8799f',
    dark: '#c74e7b',
    soft: '#fff6f9',
    sub: '#fbdce8',
    hair: '#f6dbe6',
    ink: '#482131',
    muted: '#a88394',
    bg: '#fdeef4',
    bg2: '#f8dce7',
    shadowRgb: '199,78,123',
  },
  // เขียวสดใส
  green: {
    label: 'เขียว',
    emoji: '💚',
    main: '#46ab7d',
    dark: '#1f8358',
    soft: '#f4fdf8',
    sub: '#d9f2e6',
    hair: '#d7efe2',
    ink: '#1f3b30',
    muted: '#7fa192',
    bg: '#eefaf3',
    bg2: '#d9f0e5',
    shadowRgb: '31,131,88',
  },
  // ม่วงละมุน
  purple: {
    label: 'ม่วง',
    emoji: '💜',
    main: '#8a7ad6',
    dark: '#6151b4',
    soft: '#f8f6ff',
    sub: '#e3dcfb',
    hair: '#e2dbf6',
    ink: '#2e2748',
    muted: '#9088b0',
    bg: '#f2eefc',
    bg2: '#e3dbf6',
    shadowRgb: '97,81,180',
  },
  // ส้มอบอุ่น
  orange: {
    label: 'ส้ม',
    emoji: '🧡',
    main: '#e5934a',
    dark: '#c06c1f',
    soft: '#fff9f3',
    sub: '#fbe6d2',
    hair: '#f6e6d5',
    ink: '#46301b',
    muted: '#a89179',
    bg: '#fdf3e9',
    bg2: '#f7e3cd',
    shadowRgb: '192,108,31',
  },
};

// คำแทนตัวเองของบอท — เดาจากชื่อให้อัตโนมัติ ลูกค้าจะได้ตั้งแค่ BOT_NAME ค่าเดียวก็ใช้ได้
// "น้องมะลิ" → เรียกตัวเองว่า "น้อง" / "พี่หมี" → "พี่" / "MayBot" → เรียกชื่อตัวเองเต็ม
function guessSelf(name) {
  for (const prefix of ['น้อง', 'พี่']) {
    if (name.startsWith(prefix) && name.length > prefix.length) return prefix;
  }
  return name;
}

// เปลี่ยนคำลงท้ายผู้หญิง → ผู้ชาย (ใช้เมื่อ BOT_POLITE=ชาย เท่านั้น ค่าเริ่มต้นไม่แตะอะไรเลย)
// ระวัง: "คะ" ไปโผล่กลางคำว่า "คะแนน" ได้ ต้องกันไว้
function toMale(text) {
  return String(text)
    .replace(/ค่ะ/g, 'ครับ')
    .replace(/คะ(?!แนน)/g, 'ครับ')
    .replace(/ครับครับ/g, 'ครับ'); // "นะคะค่ะ" แบบพิมพ์ติดกันจะได้ไม่ซ้ำ
}

// อ่านค่าจาก env (แยกเป็นฟังก์ชันบริสุทธิ์ไว้ให้เทสเรียกได้โดยไม่ต้องยุ่งกับ process.env)
function resolve(env = {}) {
  const name = String(env.BOT_NAME || '').trim() || 'น้องฟ้าใส';
  const themeKey = String(env.BOT_THEME || '').trim().toLowerCase();
  const theme = THEMES[themeKey] || THEMES.sky;
  const male = ['ชาย', 'ผู้ชาย', 'male', 'ครับ'].includes(String(env.BOT_POLITE || '').trim().toLowerCase());
  const say = male ? toMale : (t) => String(t);
  return {
    BOT: name,
    SELF: String(env.BOT_SELF || '').trim() || guessSelf(name),
    EMOJI: String(env.BOT_EMOJI || '').trim() || theme.emoji,
    MALE: male,
    // คำลงท้ายไว้ประกอบ prompt ของ AI
    PARTICLE: male ? 'ครับ' : 'ค่ะ/นะคะ',
    THEME: theme,
    THEME_KEY: THEMES[themeKey] ? themeKey : 'sky',
    say, // ห่อข้อความก่อนส่งออก — เพศหญิง (ค่าเริ่มต้น) คืนข้อความเดิมไม่แตะ
  };
}

module.exports = { ...resolve(process.env), resolve, guessSelf, toMale, THEMES };
