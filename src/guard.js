// ด่านกันตัวเลขแต่ง — เลขบัญชี เบอร์โทร เลขพัสดุ ที่บอทพิมพ์ออกไป ต้องมีอยู่จริงในคำสั่งประจำตัวหรือในบทสนทนา
// ทดสอบแล้ว: คำสั่งบอกให้ "บอกเลขบัญชี" แต่ไม่ได้ใส่เลข → โมเดลแต่งเลขบัญชีปลอมขึ้นมาเอง (ลูกค้าโอนผิดได้)
// เลขยาว 6 หลักขึ้นไป (ไม่นับขีด/เว้นวรรค) ที่หาไม่เจอในแหล่งข้อมูล → แทนด้วย "(ทางร้านจะแจ้งให้)"
// เลขสั้น เช่น ราคา 1,500 · รหัสไปรษณีย์ 10110 · วันที่ ไม่โดน

const LONG_NUMBER = /\d[\d\s-]{4,}\d/g;
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

function guardNumbers(reply, sources = []) {
  const known = sources.map(digitsOf).join('|');
  const removed = [];
  const text = String(reply || '').replace(LONG_NUMBER, (m) => {
    const d = digitsOf(m);
    if (d.length < 6 || known.includes(d)) return m;
    removed.push(m);
    return '(ทางร้านจะแจ้งให้)';
  });
  return { text, removed };
}

module.exports = { guardNumbers };
