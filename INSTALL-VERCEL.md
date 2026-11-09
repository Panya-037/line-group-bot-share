# ติดตั้งบน Vercel

รุ่นนี้ใช้ Vercel Functions + Turso เก็บบทสนทนาถาวร ไม่ใช้ volume หรือ DB_PATH บน Vercel
ยังรันในเครื่องด้วย SQLite เดิมได้เมื่อไม่ได้ตั้ง TURSO_DATABASE_URL

## 1. ตรวจหน้าที่บอท

ให้เจ้าของอนุมัติหน้าที่ก่อนบันทึก brief.txt และลอง npm run chat โดยกรอก OPENROUTER_API_KEY เองใน .env
ห้าม commit brief.txt, .env, ฐานข้อมูล หรือไฟล์สำรอง โค้ดตั้ง .gitignore ไว้แล้ว

## 2. สร้างฐานข้อมูล

สร้างฐานข้อมูล Turso ที่ https://turso.tech/ แล้วคัดลอก Database URL และสร้าง auth token
เจ้าของใส่เองใน Vercel Environment Variables เป็น TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN
บอทสร้างตารางเองเมื่อใช้งานครั้งแรก ไม่ต้องรัน SQL เอง

## 3. ตั้ง Vercel

ใช้ Node.js 24.x และโค้ดโฟลเดอร์นี้ (รวม api/, src/, vercel.json และ package-lock.json)
ตั้ง Framework Preset เป็น Other หาก Vercel ถาม ไม่ต้องตั้ง static Output Directory
ตัวแปร Production ที่ต้องมี:

- BOT_NAME=น้องผ้าห่ม
- LINE_CHANNEL_ACCESS_TOKEN (เจ้าของกรอก)
- LINE_CHANNEL_SECRET (เจ้าของกรอก)
- OPENROUTER_API_KEY (เจ้าของกรอก)
- ADMIN_KEY (เจ้าของคัดลอกจาก .env)
- TURSO_DATABASE_URL (เจ้าของกรอก)
- TURSO_AUTH_TOKEN (เจ้าของกรอก)
- TZ=Asia/Bangkok
- AI_MODEL=google/gemini-2.5-flash-lite (แชทประหยัด)
- VISION_MODEL=google/gemini-2.5-flash (อ่านรูปและเสียง)
- BOT_GREETING (ข้อความที่เจ้าของอนุมัติ)
- DAILY_LIMIT=100

BOT_POLITE ปล่อยว่างสำหรับค่ะ ใช้ ชาย สำหรับครับ
ถ้า deploy จาก GitHub: brief.txt ไม่อยู่ใน Git ให้ใส่เนื้อหาที่อนุมัติในตัวแปร BOT_BRIEF แทน
ถ้า deploy จากเครื่องด้วย Vercel CLI: brief.txt ไปกับไฟล์โดย .vercelignore ไม่ตัดออก
อย่าตั้ง DB_PATH=/data/chatbot.db หรือ RAILPACK_DEPLOY_APT_PACKAGES บน Vercel
@ffmpeg-installer/ffmpeg ติดตั้ง binary สำหรับ Linux ผ่าน npm และถูกแนบเข้า Function
ตั้ง maxDuration 120 วินาทีใน vercel.json; ต้องตรวจว่าแพ็กเกจบัญชีรองรับ และทดลองเสียง/วิดีโอจริง

## 4. เชื่อม LINE

หลัง Deploy สำเร็จ เปิด https://YOUR-DOMAIN/health ต้องได้ {"ok":true}
LINE Developers > Messaging API > Webhook URL = https://YOUR-DOMAIN/webhook
Production endpoint ต้องเข้าจาก LINE ได้โดยไม่มีหน้า login ของ Vercel Deployment Protection
Verify ต้อง Success แล้วเปิด Use webhook
ปิดข้อความตอบกลับอัตโนมัติ ข้อความทักทายของ LINE และการเข้าร่วมกลุ่ม
ทดสอบแอดเพื่อน ถามข้อมูลที่มี/ไม่มี ส่งรูป และเสียงจริง
Webhook ลงทะเบียนงานด้วย waitUntil ก่อนตอบ HTTP 200 เพื่อไม่ให้ Function หยุดระหว่างตอบแชท
คำขอจาก LINE มีการตรวจลายเซ็นด้วย LINE_CHANNEL_SECRET

## 5. สำรองข้อมูล

เมื่อใช้ Turso เส้นทาง /admin/backup คืน JSON (ไม่ใช่ไฟล์ .db)
ส่งรหัสผ่าน Authorization: Bearer ADMIN_KEY หลีกเลี่ยงคีย์ใน URL
เก็บสำรอง users และ messages และตั้งเวลาเรียกจากเครื่องเจ้าของหรือระบบสำรองที่ไว้ใจ
สคริปต์ bin/backup-db.sh เดิมสำหรับฐานข้อมูล SQLite ในเครื่อง/Railway เท่านั้น ห้ามใช้กับ JSON นี้
ข้อมูล JSON ใช้สำหรับส่งออก ยังไม่มีคำสั่ง restore อัตโนมัติ
ควรเปิดการสำรอง/กู้คืนของผู้ให้บริการฐานข้อมูลตามแพ็กเกจ และตรวจว่าสำรองกู้คืนได้
แจ้งลูกค้าว่าคุยกับ AI และมีการเก็บบทสนทนาและส่งข้อมูลให้บริการ AI

## ทดสอบก่อน deploy

```
npm install
npm test
node test/vercel.js
```

การทดสอบใช้ฐานข้อมูลชั่วคราว ไม่ต้องมีคีย์จริง ไม่เท่ากับการยืนยันว่า deploy หรือ LINE ใช้งานได้แล้ว
