#!/bin/bash
# สำรองฐานข้อมูลจากบอทที่รันอยู่บนคลาวด์ ลงเครื่องตัวเอง (เก็บย้อนหลัง 14 วัน)
# ใช้คู่กับ launchd/backup.plist.example — ถ้า volume บนคลาวด์พัง บทสนทนายังกู้จากที่นี่ได้
#
# ใช้ค่าจาก .env:  APP_URL (ที่อยู่บอท) + ADMIN_KEY
# รันมือ:  bash bin/backup-db.sh
set -euo pipefail
umask 077

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"

envval() { grep "^$1=" "$PROJECT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r'; }
BASE_URL="${APP_URL:-$(envval APP_URL)}"
ADMIN_KEY="${ADMIN_KEY:-$(envval ADMIN_KEY)}"
BASE_URL="${BASE_URL%/}"

if [ -z "$BASE_URL" ] || [ -z "$ADMIN_KEY" ]; then
  echo "$(date '+%F %T') ERROR: ต้องมี APP_URL และ ADMIN_KEY ใน .env ก่อน" >&2
  exit 1
fi

mkdir -p -m 700 "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'chatbot-*.db' -mtime +13 -exec rm -f -- {} +
OUT="$BACKUP_DIR/chatbot-$(date +%Y%m%d).db"
TMP="$OUT.part"
trap 'rm -f "$TMP" "$TMP-shm" "$TMP-wal"' EXIT

# รอเน็ตก่อนยิง — ตัวตั้งเวลาปลุกงานทันทีที่เครื่องตื่นจากหลับ ตอนนั้น DNS มักยังไม่มา
# ถ้าไม่รอ curl จะตายด้วย "Could not resolve host" แล้วไฟล์สำรองของคืนนั้นหายไปเงียบๆ
wait_for_net() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 8 -o /dev/null "$BASE_URL/health" 2>/dev/null; then
      [ "$i" -gt 1 ] && echo "$(date '+%F %T') เน็ตกลับมาแล้ว (รอไป $((i * 10))s)"
      return 0
    fi
    sleep 10
  done
  echo "$(date '+%F %T') ERROR: เน็ตไม่มาใน 5 นาที — ข้ามรอบนี้" >&2
  return 1
}
wait_for_net || exit 1

# ส่ง key ผ่าน curl config (stdin) — คีย์จะได้ไม่โผล่ใน process list ให้คนอื่นเห็น
curl --fail --silent --show-error --max-time 120 --config - --output "$TMP" <<CURL_CONFIG
url = "$BASE_URL/admin/backup?key=$ADMIN_KEY"
CURL_CONFIG

if ! head -c 16 "$TMP" | grep -q "SQLite format 3"; then
  echo "$(date '+%F %T') ERROR: ไฟล์ที่โหลดมาไม่ใช่ SQLite ($(head -c 100 "$TMP"))" >&2
  exit 1
fi
# เปิดอ่านจริงแบบ immutable — กันไฟล์ขาดกลางทางแล้วเก็บไว้เฉยๆ โดยไม่รู้ตัว
if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "file:$TMP?immutable=1" "PRAGMA quick_check;" 2>/dev/null | grep -qx ok; then
    echo "$(date '+%F %T') ERROR: SQLite quick_check ไม่ผ่าน" >&2
    exit 1
  fi
fi
rm -f "$TMP-shm" "$TMP-wal"

mv "$TMP" "$OUT"
echo "$(date '+%F %T') OK: $OUT ($(du -h "$OUT" | cut -f1))"
