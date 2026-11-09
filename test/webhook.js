const assert = require('node:assert/strict');
const crypto = require('node:crypto');
// Never read or use real credentials during this test.
process.env.LINE_CHANNEL_SECRET = 'offline-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'offline-test-token';
process.env.ADMIN_KEY = 'offline-admin-key';
process.env.OPENROUTER_API_KEY = 'offline-ai-key';
process.env.VERCEL = '1';
const pending = [];
const received = [];
const fakeStorage = {
  exportData: async () => ({ version: 1, users: [], messages: [] }),
};
require.cache[require.resolve('../src/db')] = { exports: fakeStorage };
require.cache[require.resolve('../src/bot')] = { exports: {
  createBot: () => ({ async handleEvent(event) {
    await new Promise(resolve => setTimeout(resolve, 30));
    received.push(event.type);
  } }),
} };
require.cache[require.resolve('@vercel/functions')] = { exports: { waitUntil: p => pending.push(p) } };
const app = require('../api/index');
async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    const body = JSON.stringify({ events: [{ type: 'message' }, { type: 'follow' }] });
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    const response = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body });
    assert.equal(response.status, 200);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.deepEqual(received, ['message', 'follow']);
    const invalid = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid' }, body });
    assert.equal(invalid.status, 401);
    assert.equal((await fetch(`${base}/admin/backup`)).status, 403);
    const backup = await fetch(`${base}/admin/backup`, { headers: { authorization: `Bearer ${process.env.ADMIN_KEY}` } });
    assert.equal(backup.status, 200);
    assert.equal(backup.headers.get('cache-control'), 'no-store');
    assert.ok(backup.headers.get('content-disposition').includes('.json'));
    assert.deepEqual((await backup.json()).messages, []);
    console.log('Vercel: health, signature validation, background lifetime, protected backup ผ่าน');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
