// fake-database.ts
// An in-memory database that behaves like a Firestore transaction: OPTIMISTIC.
// Many transactions run at once; at commit time, if anything a transaction read has
// changed since, it is thrown away and re-run. Reads deliberately pause so that
// transactions genuinely interleave (a single-threaded fake would hide races).
// TEST CODE ONLY: never ship this.

import { Database, Transaction, TransactionContention } from './database';

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

interface StoredDoc {
  data: unknown;
  version: number;
}

export class FakeDatabase implements Database {
  private docs = new Map<string, StoredDoc>();
  retries = 0; // how many times a transaction collided and re-ran
  commits = 0;

  // checkConflicts=false simulates a database WITHOUT transactions (used to prove tests have teeth)
  constructor(
    private readonly maxAttempts = 5,
    private readonly checkConflicts = true,
  ) {}

  seed<T>(path: string, data: T): void {
    this.docs.set(path, { data: structuredClone(data), version: 1 });
  }

  peek<T>(path: string): T | null {
    const d = this.docs.get(path);
    return d ? structuredClone(d.data as T) : null;
  }

  async listCollection<T>(collectionPath: string): Promise<Array<{ id: string; data: T }>> {
    await pause();
    const prefix = collectionPath + '/';
    const out: Array<{ id: string; data: T }> = [];
    for (const [path, doc] of this.docs) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        out.push({ id: path.slice(prefix.length), data: structuredClone(doc.data as T) });
      }
    }
    return out;
  }

  async getDocument<T>(path: string): Promise<T | null> {
    await pause();
    return this.peek<T>(path);
  }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const reads = new Map<string, number>(); // path -> version we saw
      const writes = new Map<string, unknown>();
      const tx: Transaction = {
        get: async <U>(path: string) => {
          // Real Firestore refuses a read after a write inside a transaction. So do we.
          if (writes.size > 0) {
            throw new Error('Transactions must do all reads before any writes (Firestore rule)');
          }
          await pause();
          const d = this.docs.get(path);
          reads.set(path, d ? d.version : 0);
          return d ? structuredClone(d.data as U) : null;
        },
        set: <U>(path: string, data: U) => {
          writes.set(path, structuredClone(data));
        },
      };

      const result = await fn(tx);

      // Real databases take time between "I finished reading" and "my commit lands".
      // Other transactions commit in that gap: that gap is where every race lives.
      await pause();

      // ---- COMMIT: this block has no await, so it is atomic ----
      let conflict = false;
      if (this.checkConflicts) {
        for (const [path, seen] of reads) {
          if ((this.docs.get(path)?.version ?? 0) !== seen) conflict = true;
        }
      }
      if (!conflict) {
        for (const [path, data] of writes) {
          this.docs.set(path, { data, version: (this.docs.get(path)?.version ?? 0) + 1 });
        }
        this.commits++;
        return result;
      }
      this.retries++;
    }
    throw new TransactionContention();
  }
}
