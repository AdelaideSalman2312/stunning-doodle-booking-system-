// database.ts
// The tiny interface our business logic needs from a database.
// Production implements it with Firestore transactions (wired in Slice 3);
// tests implement it with fake-database.ts. The business logic cannot tell the difference.

// Thrown when a transaction keeps colliding with others and gives up
// (Firestore does the same after ~5 attempts).
export class TransactionContention extends Error {
  constructor() {
    super('Transaction gave up after repeated collisions');
    this.name = 'TransactionContention';
  }
}

export interface Transaction {
  // RULE (enforced by Firestore, and by our fake): every get() must come BEFORE the first set().
  get<T>(path: string): Promise<T | null>;
  set<T>(path: string, data: T): void; // buffered; applied only if the commit succeeds
}

export interface Database {
  // Runs fn as ONE all-or-nothing unit. If another transaction changed anything fn
  // read, fn is run AGAIN from the top. Therefore fn must only read and set through tx:
  // no sending emails, no counters outside the database.
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // A plain read of a whole collection (NOT transactional): a hint of what exists right now.
  listCollection<T>(collectionPath: string): Promise<Array<{ id: string; data: T }>>;

  // A plain read of one document (NOT transactional): a hint, never a decision.
  getDocument<T>(path: string): Promise<T | null>;
}
