// Verify persistence between function instances and the asynchronous bot path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { createRemoteDb } = require('../src/remote-db');
const { createBot } = require('../src/bot');

async function main() {
  const dir = process.env.VERCEL_TEST_DIRECTORY;
  const url = `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`;
  const first = createClient({ url });
  const second = createClient({ url });
  try {
    const db = createRemoteDb({ client: first });
    await db.upsertUser('U1', 'ลูกค้า');
    await db.upsertUser('U1', null);
    assert.equal(await db.userName('U1'), 'ลูกค้า');
    const row = await db.logMessage('U1', 'user', 'M1', 'image', '[รูป]');
    await db.updateMessageText(row, '[รูป] สลิป 500 บาท');
    const fresh = createRemoteDb({ client: second });
    assert.equal((await fresh.recentMessages('U1'))[0].text, '[รูป] สลิป 500 บาท');
    assert.equal(await fresh.userMessagesToday('U1'), 1);
    assert.deepEqual(await fresh.recentMessages('U2'), []);
    const replies = [];
    const client = {
      async replyMessage(r) { replies.push(r.messages[0].text); },
      async getProfile() { throw new Error('not public'); },
    };
    const ai = { async chatReply(rows, opts) {
      assert.equal(opts.name, 'ลูกค้า');
      assert.equal(rows.at(-1).text, 'ส่งฟรีไหม');
      return 'กรุงเทพฯ และปริมณฑลจัดส่งฟรีค่ะ';
    } };
    const bot = createBot({ client, db, ai, media: {}, env: { DAILY_LIMIT: '2' } });
    const event = { type: 'message', replyToken: 'test', source: { type: 'user', userId: 'U1' }, message: { type: 'text', id: 'M2', text: 'ส่งฟรีไหม' } };
    assert.equal(await bot.handleEvent(event), 'answered');
    assert.equal(replies.length, 1);
    assert.equal((await fresh.recentMessages('U1')).at(-1).role, 'bot');
    assert.equal(await bot.handleEvent({ ...event, message: { ...event.message, id: 'M3' } }), 'limit');
    assert.equal(await fresh.userMessagesToday('U1'), 2);
    await bot.handleEvent({ type: 'unsend', source: event.source, unsend: { messageId: 'M1' } });
    assert.equal((await fresh.recentMessages('U1')).some(r => r.line_msg_id === 'M1'), false);
    const backup = await fresh.exportData();
    assert.equal(backup.users.length, 1);
    assert.equal(backup.messages.length, 2);
    console.log('Vercel: persistence, async replies, isolation, daily limit, unsend, backup ผ่าน');
  } finally {
    first.close(); second.close();
  }
}
if (process.env.VERCEL_TEST_DIRECTORY) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
} else {
  // Windows native libSQL handles remain open until the worker process exits.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-vercel-test-'));
  try {
    const result = require('node:child_process').spawnSync(process.execPath, [__filename], {
      env: { ...process.env, VERCEL_TEST_DIRECTORY: dir }, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
