// ทางเข้าบน Vercel — ทุกที่อยู่ (/webhook /health /admin/backup) ถูกส่งมาที่นี่ด้วย rewrites ใน vercel.json
// ตัวแอปจริงอยู่ที่ src/app.js (ชุดเดียวกับที่รันบน Railway)
const { app } = require('../src/app');

module.exports = app;
