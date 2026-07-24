# line-group-bot — บอทเลขาประจำกลุ่ม LINE 💙

เชิญเข้ากลุ่ม LINE แล้วบอทจะช่วย **จดแชท · สรุปงานให้ทุกวัน · ค้นย้อนหลัง · อ่านรูป/สลิป/เสียง/ไฟล์ · ตอบคำถามจากแชท** พร้อม **แดชบอร์ดรายวัน** ดูภาพรวมทุกกลุ่ม

> คำตอบทุกใบเป็นการ์ด Flex โทนฟ้า-ขาวสะอาดตา · รองรับภาษาไทย · ต้นทุน AI ต่ำ (ตอบในกลุ่มฟรี)

![CI](https://img.shields.io/badge/tests-offline%20suite-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D20-blue) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## ▶️ ลองเร็วสุด (โหมด demo — ไม่ต้องมีกลุ่มไลน์)

ดูหน้า **แดชบอร์ด**ด้วยข้อมูลจำลองได้ใน 4 บรรทัด:

```bash
git clone <repo-url> && cd line-group-bot
npm install
cp .env.example .env          # มี ADMIN_KEY=demo-key-please-change ให้แล้ว
npm run demo                  # ใส่ข้อมูลจำลอง + สตาร์ทเซิร์ฟเวอร์
```

เปิด → `http://localhost:3000/admin?key=demo-key-please-change`

จะเห็นแดชบอร์ด KPI + กราฟ 14 วัน + ตารางกลุ่ม + ยอดเงิน จากข้อมูล **สมมติ** (2 กลุ่มตัวอย่าง ไม่ใช่ข้อมูลจริงใคร)

รันเทสทั้งชุด (offline ไม่ต้องมี key):

```bash
npm test
```

> **เปิด CI (GitHub Actions):** ไฟล์ workflow อยู่ที่ [`docs/ci.yml.example`](docs/ci.yml.example) — ก๊อปไปไว้ที่ `.github/workflows/ci.yml` (ผ่านปุ่ม *Add file* บนหน้าเว็บ GitHub จะได้ workflow scope อัตโนมัติ) แล้วเทสจะรันทุก push/PR

---

## ฟีเจอร์

- **จดทุกอย่างในกลุ่ม** — ข้อความ + อ่านรูป/สลิป/เสียงพูด/วิดีโอ/ไฟล์ (AI ถอดเป็นข้อความ ค้น/สรุปต่อได้)
- **สรุปงานรายวันอัตโนมัติ** — การ์ดตาราง (งาน · ใคร · กำหนด + ยอดเงิน + เรื่องค้าง) push เข้ากลุ่มตามเวลาที่ตั้ง โดย**คัดเฉพาะเรื่องงาน ตัดคุยเล่นทิ้ง**
- **ดักจับยอดเงิน** อัตโนมัติจากข้อความและสลิป
- **ค้น/ถามย้อนหลัง** — `!ค้น`, `!ถาม`, หรือ mention บอทแล้วถามจากประวัติแชท
- **แดชบอร์ดรายวัน** `/admin` — ภาพรวมทุกกลุ่ม อัพเดตสด
- คนกด unsend → บอทลบ log ตาม

คำสั่งในกลุ่ม:

| คำสั่ง | ทำอะไร |
|---|---|
| `!ช่วย` | ดูคำสั่งทั้งหมด |
| `!สรุป` / `!สรุปเมื่อวาน` | สรุปแชทวันนี้ / เมื่อวาน |
| `!ค้น <คำ>` | ค้นข้อความย้อนหลัง |
| `!ถาม <คำถาม>` | ถาม AI จากประวัติแชท (หรือ @ บอทแล้วถาม) |
| `!ยอดเงิน` | ตัวเลขเงินที่จับได้วันนี้ |
| `!สรุปอัตโนมัติ เปิด/ปิด` · `!เวลาสรุป <0-23>` | ตั้งค่าสรุปรายวัน |

> 📐 อยากเข้าใจว่าข้อมูลไหลยังไงทั้งระบบ → ดู **[WORKFLOW.md](WORKFLOW.md)** (มีไดอะแกรม)

---

## 🔌 ต่อกับกลุ่ม LINE จริง

### 1. สร้าง LINE Official Account + เปิด Messaging API

1. [manager.line.biz](https://manager.line.biz) → สร้าง OA ใหม่
2. **ตั้งค่า → บัญชี → ฟีเจอร์ → อนุญาตให้เข้าร่วมแชทกลุ่ม** ← สำคัญสุด ไม่เปิดจะเชิญเข้ากลุ่มไม่ได้
3. **ตั้งค่า → การตอบกลับ** → ปิด *ตอบกลับอัตโนมัติ* และ *ข้อความทักทาย* (ไม่งั้นบอทสแปม)
4. [developers.line.biz](https://developers.line.biz) → channel นี้ → แท็บ Messaging API:
   - Issue **Channel access token (long-lived)** → ใส่ `LINE_CHANNEL_ACCESS_TOKEN`
   - Basic settings → **Channel secret** → ใส่ `LINE_CHANNEL_SECRET`

### 2. ใส่ค่าใน `.env`

```bash
cp .env.example .env
# กรอก LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, OPENROUTER_API_KEY, ADMIN_KEY
```

`OPENROUTER_API_KEY` เอาจาก [openrouter.ai/keys](https://openrouter.ai/keys) (ใช้สรุป/ตอบ/อ่านสื่อ)

### 3. รัน + ตั้ง webhook

```bash
npm start
```

เอา URL สาธารณะ (เช่นจาก [ngrok](https://ngrok.com) ตอน dev หรือโดเมนตอน deploy) ไปใส่ที่ LINE Developers → Messaging API → **Webhook URL** = `https://<โดเมน>/webhook` → กด Verify → เปิด **Use webhook**

### 4. เชิญบอทเข้ากลุ่ม

เชิญ OA เข้ากลุ่มเหมือนเชิญเพื่อน → บอททักแนะนำตัว เริ่มจดทันที

---

## 🚀 Deploy (ตัวอย่าง: Railway)

```bash
railway init
railway volume add            # mount เช่น /data (เก็บ SQLite ถาวร)
railway variables set DB_PATH=/data/groupbot.db
# ตั้ง env ที่เหลือ: LINE_*, OPENROUTER_API_KEY, ADMIN_KEY
railway up
```

ffmpeg (สำหรับถอดเสียง/ดึงเฟรมวิดีโอ) บน Railway ตั้งผ่าน env: `RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg`
(เครื่อง dev ติดตั้ง ffmpeg เองตามระบบปฏิบัติการ)

รองรับ platform อื่นที่รัน Node ได้ทั่วไป — ขอแค่มี persistent disk ไว้เก็บไฟล์ SQLite

---

## แดชบอร์ด & เครื่องมือแอดมิน

- `/admin?key=ADMIN_KEY` — แดชบอร์ดรายวัน (KPI, กราฟ 14 วัน, ตารางกลุ่ม, ยอดเงิน)
- `/admin/summary?key=&group=<id>` — พรีวิวสรุป (เติม `&send=1` ส่งเข้ากลุ่มจริง, `&date=YYYY-MM-DD` เลือกวัน)
- `/admin/backup?key=` — ดาวน์โหลดไฟล์ SQLite

---

## หมายเหตุความเป็นส่วนตัว

บอทเก็บข้อความ + ชื่อสมาชิกในกลุ่มลงฐานข้อมูลของคุณเอง (ไม่ส่งออกที่ไหน) — เหมาะกับกลุ่มงานภายในที่สมาชิกรับทราบ ควรบอกสมาชิกในกลุ่มว่ามีบอทช่วยจด/สรุป ชื่อสมาชิกดึงได้เฉพาะคนที่ตั้งค่าโปรไฟล์ให้บอทเห็น (คนอื่นแสดง "ไม่ทราบชื่อ")

## License

[MIT](LICENSE)
