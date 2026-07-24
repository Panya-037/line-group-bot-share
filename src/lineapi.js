// เรียก LINE API ตรงๆ ส่วนที่ SDK ไม่มี helper สะดวก (แพทเทิร์นเดียวกับ nailaoma/src/profile.js)
const TOKEN = () => process.env.LINE_CHANNEL_ACCESS_TOKEN;

async function lineGet(path) {
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  if (!res.ok) throw new Error(`LINE API ${path} → ${res.status}`);
  return res.json();
}

// ชื่อกลุ่ม + รูปกลุ่ม
function getGroupSummary(groupId) {
  return lineGet(`/v2/bot/group/${groupId}/summary`);
}

// โปรไฟล์สมาชิกในกลุ่ม (ได้เฉพาะคนที่ยินยอมเปิดเผยกับบอท)
function getGroupMemberProfile(groupId, userId) {
  return lineGet(`/v2/bot/group/${groupId}/member/${userId}`);
}

// โปรไฟล์สมาชิกใน multi-person chat (room) — endpoint คนละตัวกับ group
function getRoomMemberProfile(roomId, userId) {
  return lineGet(`/v2/bot/room/${roomId}/member/${userId}`);
}

// ข้อมูลบอทเอง — เอา userId ไว้เช็คว่าโดน mention ไหม
function getBotInfo() {
  return lineGet(`/v2/bot/info`);
}

module.exports = { getGroupSummary, getGroupMemberProfile, getRoomMemberProfile, getBotInfo };
