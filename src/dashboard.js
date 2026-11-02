// แดชบอร์ด /admin — ดูง่ายบนมือถือ: ฟิลเตอร์ช่วงเวลา/กลุ่ม → สรุปผลเป็นภาษาคน → งานที่ต้องทำ → รายละเอียด
// (ชื่อบอท/โทนสีมาจาก src/branding.js) อัพเดตสดทุกครั้งที่เปิด — ส่วน "งานที่ต้องทำ" โหลดทีหลังผ่าน /admin/tasks.json
const dayjs = require('./time');
const { db, pushCount } = require('./db');
const { BOT, SELF, EMOJI, THEME: T, say } = require('./branding');
const brief = require('./brief');

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

// ช่วงเวลาที่เลือกได้ (ฟิลเตอร์หลัก)
const RANGES = {
  today: { days: 1, label: 'วันนี้', chart: 14 },
  '7': { days: 7, label: '7 วัน', chart: 14 },
  '30': { days: 30, label: '30 วัน', chart: 30 },
};
// คีย์ '7'/'30' เป็นเลข JS เลยเรียงมาก่อน 'today' เอง — ล็อกลำดับปุ่มไว้เอง
const RANGE_ORDER = ['today', '7', '30'];

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

function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function baht(n) {
  return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}
function moneyValue(v) {
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function delta(now, before, unitLabel) {
  const diff = now - before;
  if (before === 0 && now === 0) return '';
  if (diff > 0) return `<span class="up">▲ ${num(diff)}</span> ${unitLabel}`;
  if (diff < 0) return `<span class="down">▼ ${num(-diff)}</span> ${unitLabel}`;
  return `<span class="flat">เท่าเดิม</span> ${unitLabel}`;
}

// ---------- ฟิลเตอร์ ----------
function parseFilters(q = {}) {
  const range = RANGES[q.range] ? String(q.range) : 'today';
  const { days, label } = RANGES[range];
  const to = dayjs().format('YYYY-MM-DD');
  const from = dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD');
  const prevTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
  const prevFrom = dayjs(prevTo).subtract(days - 1, 'day').format('YYYY-MM-DD');
  const gid = q.group && q.group !== 'all' ? String(q.group) : null;
  const group = gid ? db.prepare(`SELECT * FROM groups WHERE id = ?`).get(gid) : null;
  return {
    range,
    days,
    label,
    from,
    to,
    prevFrom,
    prevTo,
    compareLabel: days === 1 ? 'เทียบเมื่อวาน' : `เทียบ ${days} วันก่อนหน้า`,
    groupId: group ? group.id : null,
    groupName: group ? group.name || '(ยังไม่รู้ชื่อกลุ่ม)' : null,
  };
}

// ---------- ดึงข้อมูลตามฟิลเตอร์ ----------
function gather(f) {
  const gWhere = f.groupId ? ' AND group_id = ?' : '';
  const gArg = f.groupId ? [f.groupId] : [];
  const win = [f.from, f.to, ...gArg];
  const prevWin = [f.prevFrom, f.prevTo, ...gArg];

  const msgNow = db.prepare(`SELECT count(*) c FROM messages WHERE ${D} BETWEEN ? AND ?${gWhere}`).get(...win).c;
  const msgPrev = db.prepare(`SELECT count(*) c FROM messages WHERE ${D} BETWEEN ? AND ?${gWhere}`).get(...prevWin).c;
  const activeGroups = db
    .prepare(`SELECT count(DISTINCT group_id) c FROM messages WHERE ${D} BETWEEN ? AND ?${gWhere}`)
    .get(...win).c;

  const byType = db
    .prepare(`SELECT type, count(*) c FROM messages WHERE ${D} BETWEEN ? AND ?${gWhere} GROUP BY type`)
    .all(...win);
  const typeMap = Object.fromEntries(byType.map((r) => [r.type, r.c]));
  const media = MEDIA_TYPES.reduce((s, tp) => s + (typeMap[tp] || 0), 0);

  const money = db
    .prepare(
      `SELECT e.ts, e.value, COALESCE(g.name,'(ยังไม่รู้ชื่อกลุ่ม)') gname
       FROM extracts e LEFT JOIN groups g ON g.id = e.group_id
       WHERE e.kind='money' AND date(e.ts,'+7 hours') BETWEEN ? AND ?${f.groupId ? ' AND e.group_id = ?' : ''}
       ORDER BY e.id DESC`,
    )
    .all(...win);
  const moneySum = money.reduce((s, m) => s + moneyValue(m.value), 0);

  // กราฟย้อนหลัง — เติมวันที่ไม่มีข้อความเป็น 0
  const chartLen = RANGES[f.range].chart;
  const chartFrom = dayjs().subtract(chartLen - 1, 'day').format('YYYY-MM-DD');
  const raw = db
    .prepare(`SELECT ${D} d, count(*) c FROM messages WHERE ${D} >= ?${gWhere} GROUP BY d`)
    .all(chartFrom, ...gArg);
  const cntByDay = Object.fromEntries(raw.map((r) => [r.d, r.c]));
  const days = [];
  for (let i = chartLen - 1; i >= 0; i--) {
    const ds = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    days.push({ ds, label: dayjs(ds).format('D/M'), count: cntByDay[ds] || 0, inRange: ds >= f.from });
  }

  // ทุกกลุ่ม + ยอดในช่วงที่เลือก
  const groups = db
    .prepare(
      `SELECT g.id, COALESCE(g.name,'(ยังไม่รู้ชื่อกลุ่ม)') name, g.active, g.summary_on, g.summary_hour, g.image_reply,
        (SELECT count(*) FROM members mb WHERE mb.group_id = g.id) members,
        (SELECT count(*) FROM messages m WHERE m.group_id = g.id) total,
        (SELECT count(*) FROM messages m WHERE m.group_id = g.id AND date(m.ts,'+7 hours') BETWEEN ? AND ?) win,
        (SELECT max(ts) FROM messages m WHERE m.group_id = g.id) last_ts,
        (SELECT count(*) FROM extracts e WHERE e.group_id = g.id AND e.kind='money'
           AND date(e.ts,'+7 hours') BETWEEN ? AND ?) money_win
       FROM groups g ORDER BY win DESC, g.active DESC, total DESC`,
    )
    .all(f.from, f.to, f.from, f.to);

  const scoped = f.groupId ? groups.filter((g) => g.id === f.groupId) : groups;
  const busy = scoped.filter((g) => g.win > 0);
  const quiet = f.groupId ? [] : scoped.filter((g) => g.win === 0);
  const top = busy[0] || null;

  // รายชื่อกลุ่มสำหรับช่องเลือก — กลุ่มที่ยังอยู่ก่อน เรียงตามที่คุยล่าสุด
  const pickList = db
    .prepare(
      `SELECT g.id, COALESCE(g.name,'(ยังไม่รู้ชื่อกลุ่ม)') name, g.active,
        (SELECT max(ts) FROM messages m WHERE m.group_id = g.id) last_ts
       FROM groups g ORDER BY g.active DESC, last_ts DESC`,
    )
    .all();

  return {
    msgNow,
    msgPrev,
    activeGroups,
    typeMap,
    media,
    money,
    moneySum,
    days,
    groups,
    busy,
    quiet,
    top,
    pickList,
    totals: {
      groups: groups.length,
      activeGroups: groups.filter((g) => g.active).length,
      members: db.prepare(`SELECT count(*) c FROM members`).get().c,
      messages: db.prepare(`SELECT count(*) c FROM messages`).get().c,
    },
    push: pushCount(dayjs().format('YYYY-MM')),
  };
}

// ---------- ชิ้นส่วน HTML ----------
function kpi(label, value, sub = '', opts = {}) {
  const id = opts.id ? ` id="${opts.id}"` : '';
  return `<div class="kpi${opts.accent ? ' accent' : ''}">
    <div class="kpi-val"${id}>${value}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-sub"${opts.subId ? ` id="${opts.subId}"` : ''}>${sub}</div>
  </div>`;
}

function filterBar(f, d, key) {
  const k = encodeURIComponent(key);
  const gp = f.groupId ? `&group=${encodeURIComponent(f.groupId)}` : '';
  const chips = RANGE_ORDER.map(
    (val) =>
      `<a class="tab${val === f.range ? ' on' : ''}" href="/admin?key=${k}&range=${val}${gp}">${RANGES[val].label}</a>`,
  ).join('');
  const options = [`<option value="all"${f.groupId ? '' : ' selected'}>ทุกกลุ่ม (${d.totals.groups})</option>`]
    .concat(
      d.pickList.map(
        (g) =>
          `<option value="${esc(g.id)}"${g.id === f.groupId ? ' selected' : ''}>${esc(g.name)}${g.active ? '' : ' · ออกแล้ว'}</option>`,
      ),
    )
    .join('');
  return `<div class="fbar">
    <div class="tabs">${chips}</div>
    <form method="get" action="/admin" class="pick">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="range" value="${f.range}">
      <select name="group" onchange="this.form.submit()" aria-label="เลือกกลุ่ม">${options}</select>
    </form>
  </div>`;
}

// สรุปผลเป็นประโยคภาษาคน (ไม่ใช้ AI — คิดจากตัวเลขตรงๆ)
function verdict(f, d) {
  const where = f.groupId ? `กลุ่ม "${esc(f.groupName)}"` : 'ทุกกลุ่ม';
  if (!d.msgNow) {
    return `<p class="verdict">ช่วง <b>${f.label}</b> ${where} ${say('ยังไม่มีใครคุยกันเลยค่ะ')} 🌙</p>`;
  }
  const bits = [];
  bits.push(
    `ช่วง <b>${f.label}</b> ${where} คุยกัน <b>${num(d.msgNow)}</b> ข้อความ${
      f.groupId ? '' : ` ใน <b>${d.activeGroups}</b> กลุ่ม`
    }`,
  );
  if (d.top && !f.groupId) bits.push(`คุยเยอะสุดคือ <b>${esc(d.top.name)}</b> (${num(d.top.win)} ข้อความ)`);
  if (d.media) bits.push(`${esc(SELF)}อ่านรูป/เสียง/ไฟล์ให้ <b>${num(d.media)}</b> ชิ้น`);
  if (d.money.length)
    bits.push(`เจอยอดเงิน <b>${d.money.length}</b> รายการ รวมประมาณ <b>${baht(d.moneySum)}</b> บาท`);
  return `<p class="verdict">${bits.join(' · ')}</p>`;
}

function barChart(days) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const sparse = days.length > 20;
  const bars = days
    .map((d, i) => {
      const h = Math.round((d.count / max) * 100);
      const showLbl = !sparse || i % 3 === 0 || i === days.length - 1;
      return `<div class="bar-col" title="${d.label}: ${d.count} ข้อความ">
        <div class="bar-num">${sparse ? '' : d.count || ''}</div>
        <div class="bar${d.inRange ? ' on' : ''}" style="height:${Math.max(h, d.count ? 6 : 2)}%"></div>
        <div class="bar-lbl">${showLbl ? d.label : ''}</div>
      </div>`;
    })
    .join('');
  return `<div class="chart">${bars}</div>
    <p class="chart-note">แท่งเข้ม = ช่วงที่เลือกอยู่</p>`;
}

function typeBreakdown(typeMap) {
  const entries = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="muted">ช่วงนี้ยังไม่มีข้อความเข้ามา</p>';
  return `<div class="chips">${entries
    .map(([tp, c]) => `<span class="chip">${TYPE_LABEL[tp] || tp} <b>${num(c)}</b></span>`)
    .join('')}</div>`;
}

function groupRows(rows, key, f) {
  const k = encodeURIComponent(key);
  if (!rows.length)
    return `<tr><td colspan="4" class="muted">${say('ช่วงนี้ยังไม่มีกลุ่มไหนคุยกันเลยค่ะ — ลองขยายเป็น 7 หรือ 30 วันดูนะคะ')}</td></tr>`;
  return rows
    .map((g) => {
      const meta = [
        g.active ? '' : '<span class="pill off">ออกแล้ว</span>',
        `👥 ${g.members}`,
        `สะสม ${num(g.total)}`,
        g.summary_on ? `สรุป ${g.summary_hour}:00` : 'ปิดสรุป',
      ]
        .filter(Boolean)
        .join(' · ');
      const money = g.money_win ? `<span class="money">${g.money_win}</span>` : '<span class="muted">–</span>';
      return `<tr>
        <td>
          <a class="g-name" href="/admin?key=${k}&range=${f.range}&group=${encodeURIComponent(g.id)}">${esc(g.name)}</a>
          <div class="g-meta">${meta}</div>
        </td>
        <td class="num big">${num(g.win)}</td>
        <td class="num">${money}</td>
        <td class="nowrap muted">${ago(g.last_ts)}</td>
      </tr>`;
    })
    .join('');
}

function moneyList(rows, f) {
  if (!rows.length) return `<p class="muted">${say('ช่วงนี้ยังไม่เจอยอดเงินในแชทเลยค่ะ')}</p>`;
  const item = (m) => {
    const t = dayjs.utc(m.ts).tz();
    const when = f.days === 1 ? t.format('HH:mm') : t.format('D/M HH:mm');
    const who = f.groupId ? '' : `<span class="g">${esc(m.gname)}</span>`;
    return `<li><span class="t">${when}</span>${who || '<span class="g"></span>'} <b>${esc(m.value)}</b></li>`;
  };
  const head = rows.slice(0, 10).map(item).join('');
  const rest = rows.slice(10);
  return `<ul class="money-list">${head}</ul>${
    rest.length
      ? `<details class="more"><summary>ดูอีก ${rest.length} รายการ</summary><ul class="money-list">${rest
          .map(item)
          .join('')}</ul></details>`
      : ''
  }
  <p class="hint">${say(`ยอดเหล่านี้${SELF}จับจากข้อความ/สลิปตรงๆ อาจมีซ้ำหรือเป็นเลขอื่นที่หน้าตาคล้ายยอดเงินได้ค่ะ`)}</p>`;
}

// ---------- หน้าแดชบอร์ด ----------
// บรีฟสรุปที่ใช้อยู่ — ให้คนดูแลเห็นว่าบอทถูกสั่งให้เก็บอะไร (พับอยู่ในกล่องข้อมูลระบบ)
function briefLine() {
  if (!brief.FOCUS) return 'สรุปแบบทั่วไป (งาน/นัด/เงิน/เรื่องค้าง) — ยังไม่ได้ตั้งบรีฟสรุป SUMMARY_FOCUS หรือ brief.txt<br>';
  const from = brief.SOURCE === 'env' ? 'SUMMARY_FOCUS ใน .env' : 'ไฟล์ brief.txt';
  return `📋 บรีฟสรุป (${from}): ${esc(brief.FOCUS).replace(/\n/g, '<br>')}<br>`;
}

function renderDashboard(key, query = {}) {
  const f = parseFilters(query);
  const d = gather(f);
  const k = encodeURIComponent(key);
  const gp = f.groupId ? `&group=${encodeURIComponent(f.groupId)}` : '';
  const tasksUrl = `/admin/tasks.json?key=${k}&range=${f.range}${gp}`;
  const pushWarn = d.push >= 250;

  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(BOT)} · แดชบอร์ด</title>
<style>
  :root{
    --sky:${T.main}; --sky-dark:${T.dark}; --ink:${T.ink}; --muted:${T.muted}; --hair:${T.hair};
    --bg:${T.bg}; --bg2:${T.bg2}; --card:#ffffff; --good:#2fa36b; --warn:#e08a2b; --down:#d1607a;
    --soft:${T.soft}; --shadow:0 4px 16px rgba(${T.shadowRgb},.10);
  }
  @media (prefers-color-scheme:dark){
    :root{--ink:#dce8f2; --muted:#8299ac; --hair:#22333f; --bg:#0d1720; --bg2:#101d28;
      --card:#16232e; --soft:#132029; --shadow:0 6px 20px rgba(0,0,0,.4);}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:22px 16px 60px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:linear-gradient(165deg,var(--bg),var(--bg2));min-height:100vh;color:var(--ink);
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:900px;margin:0 auto}
  h1{font-size:1.35rem;margin:0 0 3px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:.86rem;margin:0 0 16px}
  .sub .dot{opacity:.5;margin:0 6px}
  section{margin-bottom:22px}
  h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px;font-weight:700}
  .panel{background:var(--card);border-radius:16px;padding:16px;box-shadow:var(--shadow);border:1px solid var(--hair)}
  .muted{color:var(--muted)}
  .hint{color:var(--muted);font-size:.72rem;margin:10px 0 0}

  /* ฟิลเตอร์ — ติดบนสุดเวลาเลื่อน */
  .fbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
    background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:9px 10px;
    box-shadow:var(--shadow);margin-bottom:16px}
  .tabs{display:flex;gap:4px;background:var(--soft);border-radius:10px;padding:3px}
  .tab{padding:7px 13px;border-radius:8px;font-size:.84rem;font-weight:600;color:var(--muted);text-decoration:none}
  .tab.on{background:var(--sky);color:#fff}
  .pick{margin-left:auto}
  .pick select{max-width:52vw;font:inherit;font-size:.84rem;color:var(--ink);background:var(--soft);
    border:1px solid var(--hair);border-radius:10px;padding:8px 10px}

  .verdict{font-size:.98rem;line-height:1.65;margin:0}
  .verdict b{color:var(--sky-dark)}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:14px}
  .kpi{background:var(--soft);border-radius:12px;padding:12px 13px;border:1px solid var(--hair)}
  .kpi.accent{background:linear-gradient(150deg,var(--sky),var(--sky-dark));border:none}
  .kpi.accent .kpi-val,.kpi.accent .kpi-label,.kpi.accent .kpi-sub{color:#fff}
  .kpi.accent .kpi-sub .up,.kpi.accent .kpi-sub .down,.kpi.accent .kpi-sub .flat{color:#eaf5ff}
  .kpi-val{font-size:1.65rem;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:var(--sky-dark)}
  .kpi-label{font-size:.78rem;color:var(--muted);margin-top:6px}
  .kpi-sub{font-size:.7rem;color:var(--muted);margin-top:4px;min-height:.85rem}
  .up{color:var(--good);font-weight:700} .down{color:var(--down);font-weight:700} .flat{color:var(--muted)}

  /* งานที่ต้องทำ */
  .todo{border:1px solid var(--sky);border-radius:16px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
  .todo-head{display:flex;align-items:center;gap:10px;padding:13px 16px;background:linear-gradient(150deg,var(--sky),var(--sky-dark));color:#fff}
  .todo-head .t{font-weight:800;font-size:1rem}
  .todo-head .c{font-size:.78rem;opacity:.9}
  .todo-head .reload{margin-left:auto;background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:8px;
    padding:6px 11px;font:inherit;font-size:.76rem;font-weight:600;cursor:pointer}
  .todo-head .reload:disabled{opacity:.55}
  .todo-body{padding:6px 16px 14px}
  .task{display:flex;gap:10px;padding:11px 0;border-bottom:1px solid var(--hair)}
  .task:last-child{border-bottom:none}
  .task .box{flex:none;width:17px;height:17px;border:2px solid var(--sky);border-radius:5px;margin-top:2px}
  .task .body{flex:1;min-width:0}
  .task .what{font-weight:600;font-size:.93rem;line-height:1.45}
  .task .meta{font-size:.73rem;color:var(--muted);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 8px}
  .tag{background:var(--soft);border:1px solid var(--hair);border-radius:999px;padding:1px 8px}
  .tag.due{background:rgba(63,159,218,.12);border-color:transparent;color:var(--sky-dark);font-weight:700}
  .tag.old{background:rgba(224,138,43,.14);border-color:transparent;color:var(--warn);font-weight:700}
  .pending li{font-size:.88rem;line-height:1.5;margin-bottom:5px}
  .pending{margin:4px 0 0;padding-left:20px;color:var(--ink)}
  .sub-h{font-size:.76rem;font-weight:700;color:var(--muted);margin:14px 0 2px;text-transform:uppercase;letter-spacing:.05em}
  .skel{height:14px;border-radius:7px;background:var(--soft);margin:12px 0}
  .skel.s2{width:70%} .skel.s3{width:45%}

  .chart{display:flex;gap:2px;align-items:flex-end;height:130px;padding-top:14px}
  .bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px}
  .bar{width:70%;max-width:24px;background:var(--hair);border-radius:5px 5px 0 0}
  .bar.on{background:var(--sky-dark)}
  .bar-num{font-size:.58rem;color:var(--muted);font-variant-numeric:tabular-nums;height:11px}
  .bar-lbl{font-size:.56rem;color:var(--muted);white-space:nowrap;height:10px}
  .chart-note{color:var(--muted);font-size:.7rem;text-align:right;margin:8px 0 0}

  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{background:var(--card);border:1px solid var(--hair);border-radius:999px;padding:6px 12px;font-size:.8rem}
  .chip b{color:var(--sky-dark);margin-left:3px;font-variant-numeric:tabular-nums}

  .table-wrap{overflow-x:auto;background:var(--card);border-radius:16px;box-shadow:var(--shadow);border:1px solid var(--hair)}
  table{border-collapse:collapse;width:100%;min-width:430px}
  th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--hair);font-size:.86rem;vertical-align:middle}
  th{font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums} .num.big{font-weight:800;color:var(--sky-dark)}
  .nowrap{white-space:nowrap}
  .g-name{font-weight:700;color:var(--ink);text-decoration:none;border-bottom:1px dashed var(--hair)}
  .g-meta{font-size:.7rem;color:var(--muted);margin-top:3px}
  .money{color:var(--good);font-weight:700}
  .pill{font-size:.66rem;padding:2px 7px;border-radius:999px;font-weight:700}
  .pill.off{background:rgba(209,96,122,.14);color:var(--down)}
  .btn{display:inline-block;background:var(--sky);color:#fff;text-decoration:none;padding:8px 13px;border-radius:9px;font-size:.8rem;font-weight:600}
  .btn.ghost{background:transparent;color:var(--sky-dark);border:1px solid var(--hair)}
  .money-list{list-style:none;margin:0;padding:0}
  .money-list li{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--hair);font-size:.86rem}
  .money-list li:last-child{border:none}
  .money-list .t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.78rem;white-space:nowrap}
  .money-list .g{color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .money-list b{color:var(--sky-dark);white-space:nowrap}
  details.more,details.sys{margin-top:12px}
  details>summary{cursor:pointer;color:var(--muted);font-size:.8rem;padding:6px 0}
  details.sys{background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:6px 14px 2px;box-shadow:var(--shadow)}
  .sys-body{font-size:.82rem;line-height:1.9;color:var(--muted);padding-bottom:10px}
  .sys-body a{color:var(--sky-dark)}
  .sys-body .warn{color:var(--warn);font-weight:700}
  .quiet-list{font-size:.82rem;color:var(--muted);line-height:1.8;padding-bottom:8px}
  .quiet-list a{color:var(--muted);text-decoration:none;border-bottom:1px dashed var(--hair)}
  .foot{color:var(--muted);font-size:.74rem;text-align:center;margin-top:26px}
  .foot a{color:var(--sky-dark)}
</style></head><body><div class="wrap">

  <h1>${EMOJI} ${esc(BOT)} · แดชบอร์ด</h1>
  <p class="sub">${thaiDateFull(dayjs().format('YYYY-MM-DD'))}<span class="dot">•</span>อัพเดตล่าสุด ${dayjs().format('HH:mm')} น.</p>

  ${filterBar(f, d, key)}

  <section>
    <div class="panel">
      ${verdict(f, d)}
      <div class="kpis">
        ${kpi('ข้อความ', num(d.msgNow), delta(d.msgNow, d.msgPrev, f.compareLabel), { accent: true })}
        ${kpi(
          f.groupId ? 'วันที่คุยกัน' : 'กลุ่มที่คุย',
          f.groupId
            ? d.days.filter((x) => x.inRange && x.count).length
            : `${d.activeGroups}<span style="font-size:.95rem;color:var(--muted)">/${d.totals.activeGroups}</span>`,
          f.groupId ? `จาก ${f.days} วัน` : 'กลุ่มที่บอทยังอยู่',
        )}
        ${kpi('งานที่ต้องทำ', '<span class="muted">…</span>', 'คัดจากแชท', { id: 'kpi-tasks' })}
        ${kpi('ยอดเงินที่จับได้', d.money.length ? baht(d.moneySum) : '0', `${d.money.length} รายการ`)}
      </div>
    </div>
  </section>

  <section>
    <div class="todo">
      <div class="todo-head">
        <span class="t">✅ งานที่ต้องทำ</span>
        <span class="c" id="todo-count"></span>
        <button class="reload" id="todo-reload" type="button">อ่านใหม่</button>
      </div>
      <div class="todo-body" id="todo-body">
        <div class="skel"></div><div class="skel s2"></div><div class="skel s3"></div>
        <p class="muted" style="font-size:.82rem">${esc(SELF)}กำลังอ่านแชทช่วง ${esc(f.label)} ${say('ให้อยู่นะคะ')}…</p>
      </div>
    </div>
    <p style="margin:12px 0 0"><a class="btn ghost" href="/admin/overview?key=${k}">🗒️ ดูภาพรวมกลุ่ม — วันนี้แต่ละกลุ่มคุยอะไรกันบ้าง</a></p>
  </section>

  <section>
    <h2>💰 ยอดเงินในช่วงนี้</h2>
    <div class="panel">${moneyList(d.money, f)}</div>
  </section>

  <section>
    <h2>📊 ความเคลื่อนไหว</h2>
    <div class="panel">
      ${barChart(d.days)}
      <div style="margin-top:14px">${typeBreakdown(d.typeMap)}</div>
    </div>
  </section>

  <section>
    <h2>🗂️ ${f.groupId ? 'กลุ่มที่เลือก' : `กลุ่มที่คุยกันในช่วงนี้ (${d.busy.length})`}</h2>
    <div class="table-wrap"><table>
      <tr><th>กลุ่ม</th><th class="num">ข้อความ</th><th class="num">ยอดเงิน</th><th>คุยล่าสุด</th></tr>
      ${groupRows(d.busy, key, f)}
    </table></div>
    ${
      d.quiet.length
        ? `<details class="more"><summary>กลุ่มที่เงียบในช่วงนี้ (${d.quiet.length})</summary>
            <div class="quiet-list">${d.quiet
              .map(
                (g) =>
                  `<a href="/admin?key=${k}&range=${f.range}&group=${encodeURIComponent(g.id)}">${esc(g.name)}</a> <span style="opacity:.6">— ${ago(g.last_ts)}</span>`,
              )
              .join('<br>')}</div></details>`
        : ''
    }
  </section>

  <details class="sys">
    <summary>⚙️ ข้อมูลระบบ</summary>
    <div class="sys-body">
      โควต้าส่งสรุปเข้ากลุ่มเดือนนี้ ${d.push}/300 ${pushWarn ? '<span class="warn">· ใกล้เต็มแล้ว</span>' : ''}<br>
      รู้จักสมาชิก ${num(d.totals.members)} คน · เก็บข้อความสะสม ${num(d.totals.messages)} ข้อความ · กลุ่มทั้งหมด ${d.totals.groups} (ยังอยู่ ${d.totals.activeGroups})<br>
      ${briefLine()}
      <a href="/admin/backup?key=${k}">⬇︎ ดาวน์โหลดสำรองข้อมูล (.db)</a>
    </div>
  </details>

  <p class="foot">${esc(say(`${BOT}จดให้ทุกวันค่ะ`))} ${EMOJI}</p>

</div>
<script>
(function(){
  var URL_BASE = ${JSON.stringify(tasksUrl)};
  var TODAY = ${JSON.stringify(f.to)};
  var body = document.getElementById('todo-body');
  var countEl = document.getElementById('todo-count');
  var kpiEl = document.getElementById('kpi-tasks');
  var btn = document.getElementById('todo-reload');

  function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
  function daysAgo(dateStr){
    var a=new Date(dateStr+'T00:00:00'), b=new Date(TODAY+'T00:00:00');
    return Math.round((b-a)/86400000);
  }
  function dayLabel(dateStr){
    var n=daysAgo(dateStr);
    if(n<=0) return 'วันนี้';
    if(n===1) return 'เมื่อวาน';
    return n+' วันก่อน';
  }

  function render(data){
    body.innerHTML='';
    var tasks=[], pend=[];
    (data.items||[]).forEach(function(it){
      (it.tasks||[]).forEach(function(t){ tasks.push({t:t, g:it.groupName, d:it.date}); });
      (it.pending||[]).forEach(function(p){ pend.push({p:p, g:it.groupName, d:it.date}); });
    });

    countEl.textContent = tasks.length ? tasks.length+' อย่าง' : '';
    kpiEl.innerHTML=''; kpiEl.textContent = String(tasks.length);

    if(!tasks.length && !pend.length){
      body.appendChild(el('p','muted', data.note || '${say('ช่วงนี้ยังไม่มีงานค้างจากแชทเลยค่ะ')} 🎉'));
    } else if(data.note){
      body.appendChild(el('p','hint', data.note));
    }

    tasks.forEach(function(row){
      var t=row.t||{};
      var wrap=el('div','task');
      wrap.appendChild(el('div','box'));
      var b=el('div','body');
      b.appendChild(el('div','what', t.task||'-'));
      var meta=el('div','meta');
      meta.appendChild(el('span','tag', row.g));
      if(t.owner && t.owner!=='-') meta.appendChild(el('span','tag','👤 '+t.owner));
      if(t.due && t.due!=='-') meta.appendChild(el('span','tag due','⏰ '+t.due));
      var n=daysAgo(row.d);
      meta.appendChild(el('span', n>=2?'tag old':'tag', 'คุยกัน'+(n>=2?' ':'')+dayLabel(row.d)));
      b.appendChild(meta);
      wrap.appendChild(b);
      body.appendChild(wrap);
    });

    if(pend.length){
      body.appendChild(el('div','sub-h','⏳ ยังไม่มีข้อสรุป / ต้องตามต่อ'));
      var ul=el('ul','pending');
      pend.forEach(function(row){
        var li=el('li', null, row.p);
        var s=el('span','meta'); s.textContent=' — '+row.g+' · '+dayLabel(row.d);
        li.appendChild(s);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    if(data.skipped){
      var p=el('p','hint','ยังเหลืออีก '+data.skipped+'${say(` วัน/กลุ่มที่${SELF}ยังอ่านไม่ครบ — กด "อ่านใหม่" อีกทีเพื่ออ่านต่อค่ะ`)}');
      body.appendChild(p);
    }
  }

  function load(force){
    btn.disabled=true;
    btn.textContent='กำลังอ่าน…';
    fetch(URL_BASE+(force?'&force=1':''),{headers:{'Accept':'application/json'}})
      .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
      .then(render)
      .catch(function(){
        body.innerHTML='';
        body.appendChild(el('p','muted','${say('โหลดงานไม่สำเร็จค่ะ ลองกด "อ่านใหม่" อีกทีนะคะ')}'));
      })
      .finally(function(){ btn.disabled=false; btn.textContent='อ่านใหม่'; });
  }

  btn.addEventListener('click', function(){ load(true); });
  load(false);
})();
</script>
</body></html>`;
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
    : `<p class="muted">${note ? esc(note) : say('วันนี้ยังไม่มีกลุ่มไหนคุยกันพอให้สรุปเลยค่ะ')}</p>`;
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(BOT)} · สรุปแชทวันนี้</title>
<style>
  :root{--sky:${T.main};--sky-dark:${T.dark};--ink:${T.ink};--muted:${T.muted};--hair:${T.hair};
    --bg:${T.bg};--bg2:${T.bg2};--card:#fff;--off:#d1607a;--shadow:0 4px 16px rgba(${T.shadowRgb},.10)}
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

// ---------- หน้าภาพรวมกลุ่ม /admin/overview — วันนี้แต่ละกลุ่มคุยอะไรกันบ้าง ----------
// สถิติ (ใคร กี่ข้อความ กี่โมง) เรนเดอร์จาก DB ทันที · ส่วนสรุปเนื้อหาให้ JS ทยอยดึงจาก /admin/overview/digest.json
function hm(ts) {
  return ts ? dayjs.utc(ts).tz().format('HH:mm') : '';
}

function overviewDate(q = {}) {
  const today = dayjs().format('YYYY-MM-DD');
  const raw = typeof q.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : today;
  // วันที่พิมพ์มั่ว (31 ก.พ.) หรือวันในอนาคต → ถอยกลับมาวันนี้ ไม่งั้นหัวข้อกับข้อมูลคนละวันกัน
  const ok = dayjs(raw).isValid() && dayjs(raw).format('YYYY-MM-DD') === raw;
  const date = !ok || raw > today ? today : raw;
  const diff = dayjs(today).diff(dayjs(date), 'day');
  return { date, today, label: diff === 0 ? 'วันนี้' : diff === 1 ? 'เมื่อวาน' : `วันที่ ${dayjs(date).format('D MMM')}` };
}

function talkerLine(g) {
  const bits = [];
  if (g.first_ts) bits.push(`${hm(g.first_ts)}–${hm(g.last_ts)} น.`);
  const t = (g.talkers || []).filter((x) => x.name !== 'ไม่ทราบชื่อ');
  if (t.length) {
    const head = t.slice(0, 3).map((x) => `${esc(x.name)} ${x.c}`).join(' · ');
    bits.push(head + (t.length > 3 ? ` · +${t.length - 3} คน` : ''));
  }
  if (g.media) bits.push(`📎 ${g.media}`);
  if (g.money) bits.push(`💰 ${g.money}`);
  return bits.join(' · ');
}

function renderOverview(key, query = {}, groups = []) {
  const { date, today, label } = overviewDate(query);
  const k = encodeURIComponent(key);
  const busy = groups.filter((g) => g.c > 0);
  const silent = groups.filter((g) => g.c === 0);
  const msgs = busy.reduce((s, g) => s + g.c, 0);
  const media = busy.reduce((s, g) => s + g.media, 0);
  const money = busy.reduce((s, g) => s + g.money, 0);
  const yest = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');

  const headline = busy.length
    ? `${label} มี <b>${busy.length}</b> กลุ่มที่คุยกัน รวม <b>${num(msgs)}</b> ข้อความ${
        media ? ` · ${esc(SELF)}อ่านรูป/ไฟล์ให้ <b>${num(media)}</b> ชิ้น` : ''
      }${money ? ` · เจอยอดเงิน <b>${money}</b> รายการ` : ''}`
    : `${label} ${say('ยังไม่มีกลุ่มไหนคุยกันเลยค่ะ')} 🌙`;

  const cards = busy
    .map(
      (g) => `<article class="gc" data-group="${esc(g.id)}">
      <div class="gc-top">
        <div class="gc-name">${esc(g.name)}${g.active ? '' : ' <span class="pill off">ออกแล้ว</span>'}</div>
        <div class="gc-count">${num(g.c)} ข้อความ</div>
      </div>
      <div class="gc-meta">${talkerLine(g)}</div>
      <div class="gc-body"><div class="skel"></div><div class="skel s2"></div></div>
      <div class="gc-foot">
        <a href="/admin?key=${k}&range=today&group=${encodeURIComponent(g.id)}">ดูตัวเลขกลุ่มนี้ →</a>
      </div>
    </article>`,
    )
    .join('');

  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(BOT)} · ภาพรวมกลุ่ม</title>
<style>
  :root{--sky:${T.main};--sky-dark:${T.dark};--ink:${T.ink};--muted:${T.muted};--hair:${T.hair};
    --bg:${T.bg};--bg2:${T.bg2};--card:#fff;--soft:${T.soft};--good:#2fa36b;--warn:#e08a2b;--down:#d1607a;
    --shadow:0 4px 16px rgba(${T.shadowRgb},.10)}
  @media(prefers-color-scheme:dark){:root{--ink:#dce8f2;--muted:#8299ac;--hair:#22333f;--bg:#0d1720;--bg2:#101d28;
    --card:#16232e;--soft:#132029;--shadow:0 6px 20px rgba(0,0,0,.4)}}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 16px 60px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:linear-gradient(165deg,var(--bg),var(--bg2));min-height:100vh;color:var(--ink);-webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:1.35rem;margin:0 0 3px}
  .sub{color:var(--muted);font-size:.86rem;margin:0 0 16px}
  .muted{color:var(--muted)}
  .fbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
    background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:9px 10px;box-shadow:var(--shadow);margin-bottom:16px}
  .tabs{display:flex;gap:4px;background:var(--soft);border-radius:10px;padding:3px}
  .tab{padding:7px 13px;border-radius:8px;font-size:.84rem;font-weight:600;color:var(--muted);text-decoration:none}
  .tab.on{background:var(--sky);color:#fff}
  .fbar input[type=date]{font:inherit;font-size:.82rem;color:var(--ink);background:var(--soft);border:1px solid var(--hair);
    border-radius:10px;padding:7px 9px;margin-left:auto}
  .lead{background:var(--card);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--shadow);
    padding:15px 16px;font-size:.96rem;line-height:1.6;margin-bottom:8px}
  .lead b{color:var(--sky-dark)}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
  .btn{display:inline-block;background:var(--sky);color:#fff;text-decoration:none;padding:8px 13px;border-radius:9px;
    font:inherit;font-size:.8rem;font-weight:600;border:none;cursor:pointer}
  .btn.ghost{background:transparent;color:var(--sky-dark);border:1px solid var(--hair)}
  .btn:disabled{opacity:.55}
  .gc{background:var(--card);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--shadow);
    padding:15px 16px 12px;margin-bottom:14px}
  .gc-top{display:flex;align-items:baseline;gap:10px}
  .gc-name{font-weight:800;font-size:1rem;color:var(--sky-dark);flex:1;min-width:0}
  .gc-count{font-size:.74rem;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .gc-meta{font-size:.74rem;color:var(--muted);margin-top:4px;line-height:1.6}
  .gc-body{margin-top:11px}
  .gc-head{font-weight:700;font-size:.93rem;line-height:1.5;margin-bottom:8px}
  .tp{padding:7px 0;border-top:1px solid var(--hair)}
  .tp-t{font-weight:600;font-size:.88rem;line-height:1.45}
  .tp-d{font-size:.84rem;color:var(--muted);line-height:1.55;margin-top:2px}
  .fu{margin:10px 0 0;padding:9px 11px;background:var(--soft);border-radius:10px;font-size:.83rem;line-height:1.55}
  .fu b{color:var(--warn)}
  .fu ul{margin:4px 0 0;padding-left:18px}
  .raw{font-size:.84rem;line-height:1.6}
  .raw li{margin-bottom:3px;list-style:none}
  .raw .t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.76rem;margin-right:5px}
  .raw .w{font-weight:600}
  .gc-foot{margin-top:11px;padding-top:9px;border-top:1px solid var(--hair);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .gc-foot a{color:var(--sky-dark);text-decoration:none;font-size:.78rem;font-weight:600}
  .tag{background:var(--soft);border:1px solid var(--hair);border-radius:999px;padding:2px 9px;font-size:.73rem;color:var(--muted)}
  .pill.off{font-size:.66rem;padding:2px 7px;border-radius:999px;font-weight:700;background:rgba(209,96,122,.14);color:var(--down)}
  .skel{height:13px;border-radius:7px;background:var(--soft);margin:9px 0}
  .skel.s2{width:65%}
  details{background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:6px 14px 2px;box-shadow:var(--shadow)}
  summary{cursor:pointer;color:var(--muted);font-size:.82rem;padding:6px 0}
  .silent{font-size:.82rem;color:var(--muted);line-height:1.9;padding-bottom:8px}
  .foot{color:var(--muted);font-size:.76rem;text-align:center;margin-top:24px}
  .foot a{color:var(--sky-dark)}
</style></head><body><div class="wrap">

  <h1>🗒️ ภาพรวมกลุ่ม</h1>
  <p class="sub">${thaiDateFull(date)}<span style="opacity:.5;margin:0 6px">•</span>อ่านตอน ${dayjs().format('HH:mm')} น.</p>

  <div class="fbar">
    <div class="tabs">
      <a class="tab${date === today ? ' on' : ''}" href="/admin/overview?key=${k}">วันนี้</a>
      <a class="tab${date === yest ? ' on' : ''}" href="/admin/overview?key=${k}&date=${yest}">เมื่อวาน</a>
    </div>
    <form method="get" action="/admin/overview">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="date" name="date" value="${date}" max="${today}" onchange="this.form.submit()">
    </form>
  </div>

  <p class="lead">${headline}</p>
  <div class="actions">
    <a class="btn ghost" href="/admin?key=${k}">← กลับแดชบอร์ด</a>
    ${busy.length ? '<button class="btn ghost" id="again" type="button">อ่านใหม่ทั้งหมด</button>' : ''}
  </div>

  ${cards || `<p class="muted">${say('ลองเลือกวันอื่นดูนะคะ')}</p>`}

  ${
    silent.length
      ? `<details><summary>กลุ่มที่เงียบ${esc(label)} (${silent.length})</summary>
          <div class="silent">${silent.map((g) => esc(g.name)).join('<br>')}</div></details>`
      : ''
  }

  <p class="foot"><a href="/admin/report?key=${k}">📝 อยากอ่านสรุปแบบร้อยแก้วยาว ๆ ของวันนี้</a></p>
</div>
<script>
(function(){
  var KEY = ${JSON.stringify(k)};
  var DATE = ${JSON.stringify(date)};
  var cards = Array.prototype.slice.call(document.querySelectorAll('.gc'));
  var again = document.getElementById('again');

  function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }

  function fill(card, d){
    var body = card.querySelector('.gc-body');
    body.innerHTML='';
    if(d.error){ body.appendChild(el('p','muted','${say('สรุปไม่สำเร็จ ลองกดอ่านใหม่อีกทีนะคะ')}')); return; }

    if(d.raw && d.raw.length){            // ข้อความไม่กี่บรรทัด — โชว์ของจริง
      var ul=el('ul','raw'); ul.style.margin='0'; ul.style.padding='0';
      d.raw.forEach(function(r){
        var li=el('li');
        li.appendChild(el('span','t', r.time));
        li.appendChild(el('span','w', r.who+': '));
        li.appendChild(document.createTextNode(r.text));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    } else {
      if(d.headline) body.appendChild(el('div','gc-head', d.headline));
      (d.topics||[]).forEach(function(t){
        var w=el('div','tp');
        if(t.title) w.appendChild(el('div','tp-t','• '+t.title));
        if(t.detail) w.appendChild(el('div','tp-d', t.detail));
        body.appendChild(w);
      });
      if(!d.headline && !(d.topics||[]).length) body.appendChild(el('p','muted','${say('วันนี้ไม่มีอะไรเป็นเรื่องเป็นราวค่ะ')}'));
      if((d.followups||[]).length){
        var fu=el('div','fu');
        fu.appendChild(el('b','','⏳ ต้องตามต่อ'));
        var ul2=el('ul');
        d.followups.forEach(function(x){ ul2.appendChild(el('li',null,x)); });
        fu.appendChild(ul2);
        body.appendChild(fu);
      }
    }
    if(d.stale){
      var st=el('p','muted','* มีข้อความใหม่เข้ามาหลังสรุปนี้ — กด "อ่านใหม่ทั้งหมด" เพื่ออัปเดต');
      st.style.fontSize='.73rem'; st.style.marginTop='9px';
      body.appendChild(st);
    }
    if(d.taskCount){
      var foot=card.querySelector('.gc-foot');
      if(foot && !foot.querySelector('.tag')) foot.insertBefore(el('span','tag','✅ งานที่ต้องทำ '+d.taskCount), foot.firstChild);
    }
  }

  function load(card, force){
    var g = card.getAttribute('data-group');
    var body = card.querySelector('.gc-body');
    body.innerHTML='<div class="skel"></div><div class="skel s2"></div>';
    return fetch('/admin/overview/digest.json?key='+KEY+'&date='+DATE+'&group='+encodeURIComponent(g)+(force?'&force=1':''))
      .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(d){ fill(card, d); })
      .catch(function(){ fill(card, {error:true}); });
  }

  // ทีละ 2 กลุ่ม — การ์ดแรกๆ ขึ้นเร็ว ไม่ยิงพร้อมกันรัวๆ
  function runAll(force){
    if(again){ again.disabled=true; again.textContent='กำลังอ่าน…'; }
    var i=0;
    function next(){
      if(i>=cards.length) return Promise.resolve();
      var c=cards[i++];
      return load(c, force).then(next);
    }
    return Promise.all([next(), next()]).then(function(){
      if(again){ again.disabled=false; again.textContent='อ่านใหม่ทั้งหมด'; }
    });
  }

  if(again) again.addEventListener('click', function(){ runAll(true); });
  runAll(false);
})();
</script>
</body></html>`;
}

module.exports = { renderDashboard, renderReport, renderOverview, overviewDate, parseFilters };
