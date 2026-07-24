// แดชบอร์ดรายวัน /admin — ภาพรวมทุกกลุ่ม อัพเดตทุกครั้งที่เปิด (โทนฟ้า-ขาวเข้าธีมน้องฟ้าใส)
const dayjs = require('./time');
const { db, pushCount } = require('./db');

const D = "date(ts,'+7 hours')"; // แปลง UTC → วันไทย
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const TYPE_LABEL = {
  text: '💬 ข้อความ',
  image: '🖼️ รูป',
  sticker: '😺 สติกเกอร์',
  audio: '🎤 เสียงพูด',
  video: '🎬 วิดีโอ',
  file: '📄 ไฟล์',
  location: '📍 ตำแหน่ง',
};
const MEDIA_TYPES = ['image', 'audio', 'video', 'file'];

function thaiDateFull(dateStr) {
  const d = dayjs(dateStr);
  return `${d.format('dddd D MMMM')} ${d.year() + 543}`;
}

// เวลาห่างจากตอนนี้แบบอ่านง่าย
function ago(ts) {
  if (!ts) return 'ยังไม่มี';
  const m = dayjs.utc(ts).tz();
  const now = dayjs();
  const min = now.diff(m, 'minute');
  if (min < 1) return 'เมื่อกี้นี้';
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const h = now.diff(m, 'hour');
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  const d = now.diff(m, 'day');
  if (d < 7) return `${d} วันก่อน`;
  return m.format('D MMM');
}

function delta(today, yesterday) {
  const diff = today - yesterday;
  if (yesterday === 0 && today === 0) return '';
  if (diff > 0) return `<span class="up">▲ ${diff}</span> จากเมื่อวาน`;
  if (diff < 0) return `<span class="down">▼ ${-diff}</span> จากเมื่อวาน`;
  return `<span class="flat">เท่าเมื่อวาน</span>`;
}

function gather() {
  const today = dayjs().format('YYYY-MM-DD');
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const month = dayjs().format('YYYY-MM');

  const msgToday = db.prepare(`SELECT count(*) c FROM messages WHERE ${D}=?`).get(today).c;
  const msgYest = db.prepare(`SELECT count(*) c FROM messages WHERE ${D}=?`).get(yesterday).c;
  const activeToday = db.prepare(`SELECT count(DISTINCT group_id) c FROM messages WHERE ${D}=?`).get(today).c;

  const byType = db.prepare(`SELECT type, count(*) c FROM messages WHERE ${D}=? GROUP BY type`).all(today);
  const typeMap = Object.fromEntries(byType.map((r) => [r.type, r.c]));
  const mediaToday = MEDIA_TYPES.reduce((s, tp) => s + (typeMap[tp] || 0), 0);

  const moneyToday = db
    .prepare(
      `SELECT e.ts, e.value, COALESCE(g.name,'กลุ่ม') gname
       FROM extracts e LEFT JOIN groups g ON g.id=e.group_id
       WHERE e.kind='money' AND ${D.replace('ts', 'e.ts')}=? ORDER BY e.id DESC`,
    )
    .all(today);

  // 14 วันย้อนหลัง เติมวันที่ไม่มีข้อความเป็น 0
  const raw = db
    .prepare(`SELECT ${D} d, count(*) c FROM messages WHERE ${D} >= date('now','+7 hours','-13 days') GROUP BY d`)
    .all();
  const cntByDay = Object.fromEntries(raw.map((r) => [r.d, r.c]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const ds = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    days.push({ ds, label: dayjs(ds).format('D/M'), count: cntByDay[ds] || 0 });
  }

  const groups = db
    .prepare(
      `SELECT g.*,
        (SELECT count(*) FROM members mb WHERE mb.group_id=g.id) members,
        (SELECT count(*) FROM messages m WHERE m.group_id=g.id) total,
        (SELECT count(*) FROM messages m WHERE m.group_id=g.id AND ${D.replace('ts', 'm.ts')}=?) today,
        (SELECT max(ts) FROM messages m WHERE m.group_id=g.id) last_ts,
        (SELECT count(*) FROM extracts e WHERE e.group_id=g.id AND e.kind='money' AND ${D.replace('ts', 'e.ts')}=?) money_today
       FROM groups g ORDER BY g.active DESC, today DESC, total DESC`,
    )
    .all(today, today);

  const totals = {
    groups: groups.length,
    members: db.prepare(`SELECT count(*) c FROM members`).get().c,
    messages: db.prepare(`SELECT count(*) c FROM messages`).get().c,
  };

  return { today, msgToday, msgYest, activeToday, typeMap, mediaToday, moneyToday, days, groups, totals, push: pushCount(month) };
}

// ---------- ชิ้นส่วน HTML ----------
function kpi(label, value, sub = '', accent = false) {
  return `<div class="kpi${accent ? ' accent' : ''}">
    <div class="kpi-val">${value}</div>
    <div class="kpi-label">${label}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function barChart(days) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const bars = days
    .map((d, i) => {
      const h = Math.round((d.count / max) * 100);
      const isToday = i === days.length - 1;
      return `<div class="bar-col" title="${d.label}: ${d.count} ข้อความ">
        <div class="bar-num">${d.count || ''}</div>
        <div class="bar${isToday ? ' today' : ''}" style="height:${Math.max(h, d.count ? 6 : 2)}%"></div>
        <div class="bar-lbl">${d.label}</div>
      </div>`;
    })
    .join('');
  return `<div class="chart">${bars}</div>`;
}

function typeBreakdown(typeMap) {
  const entries = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="muted">วันนี้ยังไม่มีข้อความเข้ามา</p>';
  return `<div class="chips">${entries
    .map(([tp, c]) => `<span class="chip">${TYPE_LABEL[tp] || tp} <b>${c}</b></span>`)
    .join('')}</div>`;
}

function groupRows(groups, key, today) {
  if (!groups.length) return `<tr><td colspan="6" class="muted">ยังไม่มีกลุ่ม — เชิญน้องฟ้าใสเข้ากลุ่มก่อนนะคะ 🐣</td></tr>`;
  return groups
    .map((g) => {
      const activePill = g.active
        ? '<span class="pill on">อยู่ในกลุ่ม</span>'
        : '<span class="pill off">ออกแล้ว</span>';
      const sched = g.summary_on ? `ทุกวัน ${g.summary_hour}:00` : '<span class="muted">ปิด</span>';
      const money = g.money_today ? `<span class="money">${g.money_today}</span>` : '<span class="muted">–</span>';
      return `<tr>
        <td>
          <div class="g-name">${esc(g.name || '(ยังไม่รู้ชื่อกลุ่ม)')}</div>
          <div class="g-meta">${activePill} · 👥 ${g.members} · ⏰ ${sched}</div>
        </td>
        <td class="num big">${g.today}</td>
        <td class="num">${g.total}</td>
        <td class="num">${money}</td>
        <td class="nowrap muted">${ago(g.last_ts)}</td>
        <td class="nowrap"><a class="btn" href="/admin/summary?key=${encodeURIComponent(key)}&group=${encodeURIComponent(g.id)}">พรีวิวสรุป</a></td>
      </tr>`;
    })
    .join('');
}

function moneyList(rows) {
  if (!rows.length) return '<p class="muted">วันนี้ยังไม่เจอยอดเงินในกลุ่มไหนเลย</p>';
  return `<ul class="money-list">${rows
    .slice(0, 12)
    .map(
      (m) =>
        `<li><span class="t">${dayjs.utc(m.ts).tz().format('HH:mm')}</span> <span class="g">${esc(m.gname)}</span> <b>${esc(m.value)}</b></li>`,
    )
    .join('')}</ul>`;
}

function renderDashboard(key) {
  const d = gather();
  const pushWarn = d.push >= 250;
  const k = encodeURIComponent(key);
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>น้องฟ้าใส · แดชบอร์ด</title>
<style>
  :root{
    --sky:#3f9fda; --sky-dark:#1f7ac0; --ink:#213648; --muted:#8399a8; --hair:#e2edf6;
    --bg:#eef5fb; --bg2:#dceaf6; --card:#ffffff; --good:#2fa36b; --warn:#e08a2b; --down:#d1607a;
    --shadow:0 4px 16px rgba(31,122,192,.10);
  }
  @media (prefers-color-scheme:dark){
    :root{--ink:#dce8f2; --muted:#8299ac; --hair:#22333f; --bg:#0d1720; --bg2:#101d28;
      --card:#16232e; --shadow:0 6px 20px rgba(0,0,0,.4);}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:26px 18px 60px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:linear-gradient(165deg,var(--bg),var(--bg2));min-height:100vh;color:var(--ink);
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:940px;margin:0 auto}
  h1{font-size:1.45rem;margin:0 0 3px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:.9rem;margin:0 0 22px}
  .sub .dot{opacity:.5;margin:0 6px}
  section{margin-bottom:28px}
  h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:700}

  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:13px}
  .kpi{background:var(--card);border-radius:14px;padding:15px 16px;box-shadow:var(--shadow);border:1px solid var(--hair)}
  .kpi.accent{background:linear-gradient(150deg,var(--sky),var(--sky-dark));border:none}
  .kpi.accent .kpi-val,.kpi.accent .kpi-label,.kpi.accent .kpi-sub{color:#fff}
  .kpi.accent .kpi-sub .up,.kpi.accent .kpi-sub .down,.kpi.accent .kpi-sub .flat{color:#eaf5ff}
  .kpi-val{font-size:1.9rem;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:var(--sky-dark)}
  .kpi-label{font-size:.82rem;color:var(--muted);margin-top:6px}
  .kpi-sub{font-size:.72rem;color:var(--muted);margin-top:5px}
  .up{color:var(--good);font-weight:700} .down{color:var(--down);font-weight:700} .flat{color:var(--muted)}

  .panel{background:var(--card);border-radius:16px;padding:18px 18px 14px;box-shadow:var(--shadow);border:1px solid var(--hair)}
  .chart{display:flex;gap:2px;align-items:flex-end;height:150px;padding-top:16px}
  .bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px}
  .bar{width:70%;max-width:26px;background:var(--sky);border-radius:5px 5px 0 0;transition:height .3s}
  .bar.today{background:var(--sky-dark)}
  .bar-num{font-size:.6rem;color:var(--muted);font-variant-numeric:tabular-nums;height:12px}
  .bar-lbl{font-size:.58rem;color:var(--muted);white-space:nowrap}

  .chips{display:flex;flex-wrap:wrap;gap:9px}
  .chip{background:var(--card);border:1px solid var(--hair);border-radius:999px;padding:7px 13px;font-size:.82rem;box-shadow:var(--shadow)}
  .chip b{color:var(--sky-dark);margin-left:3px;font-variant-numeric:tabular-nums}

  .table-wrap{overflow-x:auto;background:var(--card);border-radius:16px;box-shadow:var(--shadow);border:1px solid var(--hair)}
  table{border-collapse:collapse;width:100%;min-width:560px}
  th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--hair);font-size:.87rem;vertical-align:middle}
  th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums} .num.big{font-weight:800;color:var(--sky-dark);font-size:1.05rem}
  .nowrap{white-space:nowrap}
  .g-name{font-weight:700} .g-meta{font-size:.72rem;color:var(--muted);margin-top:3px}
  .money{color:var(--good);font-weight:700}
  .pill{font-size:.68rem;padding:2px 8px;border-radius:999px;font-weight:700}
  .pill.on{background:rgba(47,163,107,.14);color:var(--good)} .pill.off{background:rgba(209,96,122,.14);color:var(--down)}
  .btn{display:inline-block;background:var(--sky);color:#fff;text-decoration:none;padding:6px 12px;border-radius:8px;font-size:.78rem;font-weight:600}
  .btn:hover{background:var(--sky-dark)}
  .money-list{list-style:none;margin:0;padding:0}
  .money-list li{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--hair);font-size:.87rem}
  .money-list li:last-child{border:none}
  .money-list .t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.8rem}
  .money-list .g{color:var(--muted);flex:1} .money-list b{color:var(--sky-dark)}
  .muted{color:var(--muted)}
  .foot{color:var(--muted);font-size:.76rem;text-align:center;margin-top:30px}
  .foot a{color:var(--sky-dark)}
  .quota{margin-top:6px} .quota.warn{color:var(--warn);font-weight:700}
</style></head><body><div class="wrap">

  <h1>🐣 น้องฟ้าใส · แดชบอร์ด</h1>
  <p class="sub">${thaiDateFull(d.today)}<span class="dot">•</span>อัพเดตล่าสุด ${dayjs().format('HH:mm')} น.</p>
  <p style="margin:-8px 0 22px"><a class="btn" href="/admin/report?key=${k}">📝 อ่านสรุปแชทวันนี้ทุกกลุ่ม (สำหรับดูเอง ไม่เข้ากลุ่ม)</a></p>

  <section>
    <div class="kpis">
      ${kpi('ข้อความวันนี้', d.msgToday, delta(d.msgToday, d.msgYest), true)}
      ${kpi('กลุ่มที่คุยวันนี้', `${d.activeToday}<span style="font-size:1rem;color:var(--muted)">/${d.totals.groups}</span>`, 'จากทั้งหมด')}
      ${kpi('รูป/เสียง/ไฟล์ที่อ่าน', d.mediaToday, 'วันนี้')}
      ${kpi('ยอดเงินที่จับได้', d.moneyToday.length, 'รายการวันนี้')}
      ${kpi('push เดือนนี้', `${d.push}<span style="font-size:1rem;color:var(--muted)">/300</span>`, pushWarn ? '<span class="quota warn">ใกล้เต็มโควต้าฟรี</span>' : 'โควต้าฟรี')}
    </div>
  </section>

  <section>
    <h2>📊 ข้อความ 14 วันล่าสุด</h2>
    <div class="panel">${barChart(d.days)}</div>
  </section>

  <section>
    <h2>วันนี้มีอะไรเข้ามาบ้าง</h2>
    ${typeBreakdown(d.typeMap)}
  </section>

  <section>
    <h2>🗂️ ทุกกลุ่ม</h2>
    <div class="table-wrap"><table>
      <tr><th>กลุ่ม</th><th class="num">วันนี้</th><th class="num">สะสม</th><th class="num">ยอดเงินวันนี้</th><th>คุยล่าสุด</th><th></th></tr>
      ${groupRows(d.groups, key, d.today)}
    </table></div>
  </section>

  <section>
    <h2>💰 ยอดเงินที่จับได้วันนี้</h2>
    <div class="panel">${moneyList(d.moneyToday)}</div>
  </section>

  <p class="foot">
    รู้จักสมาชิก ${d.totals.members} คน · เก็บข้อความสะสม ${d.totals.messages} ข้อความ<br>
    <a href="/admin/backup?key=${k}">⬇︎ ดาวน์โหลดสำรองข้อมูล (.db)</a>
  </p>

</div></body></html>`;
}

// ---------- หน้ารายงานสรุปวันนี้ทุกกลุ่ม (ดูเอง ไม่ push เข้ากลุ่ม) ----------
// items = [{ name, active, count, prose }] — prose คือสรุปร้อยแก้วจาก summarizeDay
const REPORT_HEADERS = ['📌', '✅', '💰', '⏳', '📊', '🗓️'];
function proseHtml(prose) {
  return String(prose)
    .split('\n')
    .filter((l) => l.trim())
    .map((raw) => {
      const line = esc(raw.trim());
      const isHead = REPORT_HEADERS.some((e) => raw.trim().startsWith(e));
      return isHead
        ? `<div class="rp-head">${line}</div>`
        : `<div class="rp-line">${line}</div>`;
    })
    .join('');
}

function renderReport(items, key, dateStr, note) {
  const k = encodeURIComponent(key);
  const cards = items.length
    ? items
        .map(
          (it) => `<section class="rp-card">
        <div class="rp-title">${esc(it.name)}${it.active ? '' : ' <span class="rp-off">ออกแล้ว</span>'}
          <span class="rp-count">${it.count} ข้อความวันนี้</span></div>
        <div class="rp-body">${proseHtml(it.prose)}</div>
      </section>`,
        )
        .join('')
    : `<p class="muted">${note ? esc(note) : 'วันนี้ยังไม่มีกลุ่มไหนคุยกันพอให้สรุปเลยค่ะ'}</p>`;
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>น้องฟ้าใส · สรุปแชทวันนี้</title>
<style>
  :root{--sky:#3f9fda;--sky-dark:#1f7ac0;--ink:#213648;--muted:#8399a8;--hair:#dbeaf6;
    --bg:#eef5fb;--bg2:#dceaf6;--card:#fff;--off:#d1607a;--shadow:0 4px 16px rgba(31,122,192,.10)}
  @media(prefers-color-scheme:dark){:root{--ink:#dce8f2;--muted:#8299ac;--hair:#22333f;--bg:#0d1720;--bg2:#101d28;--card:#16232e;--shadow:0 6px 20px rgba(0,0,0,.4)}}
  *{box-sizing:border-box}
  body{margin:0;padding:26px 18px 60px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:linear-gradient(165deg,var(--bg),var(--bg2));min-height:100vh;color:var(--ink)}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.4rem;margin:0 0 3px}
  .sub{color:var(--muted);font-size:.9rem;margin:0 0 8px}
  .note{background:#fffbe8;border:1px solid #f0e0a8;color:#7a6410;border-radius:10px;padding:9px 13px;font-size:.82rem;margin:0 0 22px}
  @media(prefers-color-scheme:dark){.note{background:#2a2410;border-color:#5c5320;color:#d8c98a}}
  .rp-card{background:var(--card);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--shadow);padding:18px 20px;margin-bottom:18px}
  .rp-title{font-weight:800;font-size:1.05rem;color:var(--sky-dark);display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--hair)}
  .rp-count{font-size:.72rem;font-weight:600;color:var(--muted);margin-left:auto}
  .rp-off{font-size:.68rem;background:rgba(209,96,122,.14);color:var(--off);padding:2px 8px;border-radius:999px;font-weight:700}
  .rp-head{font-weight:700;color:var(--sky-dark);margin:14px 0 4px;font-size:.92rem}
  .rp-head:first-child{margin-top:0}
  .rp-line{color:var(--ink);font-size:.9rem;line-height:1.55;padding-left:2px}
  .muted{color:var(--muted)}
  .foot{color:var(--muted);font-size:.78rem;text-align:center;margin-top:26px}
  .foot a{color:var(--sky-dark)}
</style></head><body><div class="wrap">
  <h1>📝 สรุปแชทวันนี้</h1>
  <p class="sub">${thaiDateFull(dateStr)}<span style="opacity:.5;margin:0 6px">•</span>อ่านตอน ${dayjs().format('HH:mm')} น.</p>
  <p class="note">🔒 หน้านี้สำหรับดูเอง — ไม่มีอะไรถูกส่งเข้ากลุ่ม (สรุปคัดประเด็นสำคัญด้วย AI)</p>
  ${cards}
  <p class="foot"><a href="/admin?key=${k}">← กลับแดชบอร์ด</a></p>
</div></body></html>`;
}

module.exports = { renderDashboard, renderReport };
