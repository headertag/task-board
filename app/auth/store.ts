import { database } from '../../lib/db';
import type { TransactionStore } from '../../lib/browser-auth';
export const transactionStore: TransactionStore = {
  async put(key, expiresAt) {
    const db = database();
    await db.batch([
      db.prepare('DELETE FROM oauth_transactions WHERE expires_at <= ?').bind(Math.floor(Date.now()/1000)),
      db.prepare('INSERT INTO oauth_transactions (state_hash, expires_at) VALUES (?, ?)').bind(key, expiresAt),
    ]);
  },
  async consume(key, now) {
    const result = await database().prepare('DELETE FROM oauth_transactions WHERE state_hash = ? AND expires_at > ?').bind(key, now).run();
    return result.meta.changes === 1;
  },
};
