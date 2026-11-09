// Persistent SQLite-compatible storage shared across Vercel function instances.
function createRemoteDb({ client, env = process.env } = {}) {
  client ||= require('@libsql/client').createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
  let initializing;
  function ready() {
    if (!initializing) {
      initializing = client.batch([
        `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT, first_seen TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', line_msg_id TEXT, type TEXT NOT NULL DEFAULT 'text', text TEXT, ts TEXT DEFAULT (datetime('now')))`,
        'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_lineid ON messages(line_msg_id)',
      ], 'write').catch((err) => { initializing = null; throw err; });
    }
    return initializing;
  }
  async function execute(sql, args = []) {
    await ready();
    return client.execute({ sql, args });
  }
  return {
    ready,
    async upsertUser(id, displayName) {
      await execute(`INSERT INTO users (id, display_name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)`, [id, displayName || null]);
    },
    async userName(id) {
      return (await execute('SELECT display_name FROM users WHERE id = ?', [id])).rows[0]?.display_name || '';
    },
    async knownUser(id) {
      return (await execute('SELECT 1 FROM users WHERE id = ?', [id])).rows.length > 0;
    },
    async logMessage(userId, role, lineMsgId, type, text) {
      return Number((await execute('INSERT INTO messages (user_id, role, line_msg_id, type, text) VALUES (?, ?, ?, ?, ?)', [userId, role, lineMsgId || null, type, text])).lastInsertRowid);
    },
    async updateMessageText(id, text) {
      await execute('UPDATE messages SET text = ? WHERE id = ?', [text, id]);
    },
    async deleteByLineMsgId(id) {
      return (await execute('DELETE FROM messages WHERE line_msg_id = ?', [id])).rowsAffected > 0;
    },
    async recentMessages(id, limit = 60) {
      return (await execute('SELECT * FROM (SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', [id, limit])).rows;
    },
    async userMessagesToday(id) {
      return Number((await execute(`SELECT count(*) c FROM messages WHERE user_id = ? AND role = 'user' AND date(ts, '+7 hours') = date('now', '+7 hours')`, [id])).rows[0].c);
    },
    async exportData() {
      await ready();
      const [users, messages] = await client.batch(['SELECT * FROM users ORDER BY id', 'SELECT * FROM messages ORDER BY id'], 'read');
      return { version: 1, exportedAt: new Date().toISOString(), users: users.rows, messages: messages.rows };
    },
  };
}
module.exports = { createRemoteDb };
