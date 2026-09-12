import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEventsResult, Conversation, Message, Project, ReviewRecord, Run, RunEvent, WorkspaceSnapshot } from './contracts.js';

type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'app.sqlite'));
    chmodSync(join(root, 'app.sqlite'), 0o600);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 4) { this.db.close(); throw new Error('This data directory was created by a newer Randolph version.'); }
    if (version >= 3 && !this.tableExists('projects')) { this.db.close(); throw new Error('This Randolph database is corrupt.'); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);`);
    if (version < 3) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS delegation_plans (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), revision INTEGER NOT NULL, digest TEXT NOT NULL, basis_digest TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(run_id, revision));
      CREATE TABLE IF NOT EXISTS delegation_authorizations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), plan_id TEXT NOT NULL REFERENCES delegation_plans(id), digest TEXT NOT NULL, basis_digest TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_preset_saves (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), plan_id TEXT NOT NULL REFERENCES delegation_plans(id), digest TEXT NOT NULL, basis_digest TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), authorization_id TEXT NOT NULL REFERENCES delegation_authorizations(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_sessions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT REFERENCES delegation_tasks(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_tool_receipts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), session_id TEXT NOT NULL REFERENCES delegation_sessions(id), call_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(session_id, call_id), UNIQUE(session_id, request_id));
      CREATE INDEX IF NOT EXISTS delegation_plans_run ON delegation_plans(run_id, revision);
      CREATE INDEX IF NOT EXISTS delegation_sessions_run ON delegation_sessions(run_id);
      PRAGMA user_version=3;
      COMMIT;`);
    if (version < 4) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS delegation_controls (run_id TEXT PRIMARY KEY REFERENCES runs(id), authorization_id TEXT NOT NULL REFERENCES delegation_authorizations(id), document TEXT NOT NULL);
      PRAGMA user_version=4;
      COMMIT;`);
  }
  private tableExists(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  transaction<T>(action: () => T): T {
    const outer = this.transactionDepth === 0, savepoint = `randolph_transaction_${this.transactionDepth}`;
    if (outer) this.db.exec('BEGIN IMMEDIATE'); else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Store transactions must be synchronous.');
      if (outer) this.db.exec('COMMIT'); else this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); return result;
    } catch (error) {
      try { if (outer) this.db.exec('ROLLBACK'); else { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); } } catch { /* Preserve the finalization failure. */ }
      throw error;
    } finally { this.transactionDepth -= 1; }
  }
  projects(): Project[] { return this.documents('projects'); }
  conversations(): Conversation[] { return this.documents('conversations'); }
  runs(): Run[] { return this.documents('runs'); }
  messages(conversationId?: string): Message[] { return this.documents<Message>('messages').filter(message => !conversationId || message.conversationId === conversationId); }
  reviews(): ReviewRecord[] { return this.documents('reviews'); }
  putReview(review: ReviewRecord): void {
    this.db.prepare('INSERT INTO reviews VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(review.id, review.conversationId, JSON.stringify(review));
  }
  private documents<T>(table: 'projects' | 'conversations' | 'runs' | 'messages' | 'reviews'): T[] {
    return (this.db.prepare(`SELECT document FROM ${table} ORDER BY rowid`).all() as Row[]).map(row => JSON.parse(String(row.document)) as T);
  }
  putProject(project: Project): void {
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(project.id, project.root, JSON.stringify(project));
  }
  putConversation(conversation: Conversation): void {
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(conversation.id, conversation.projectId, JSON.stringify(conversation));
  }
  putRun(run: Run): void {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(run.id, run.conversationId, JSON.stringify(run));
  }
  putMessage(message: Message): void {
    this.db.prepare('INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(message.id, message.runId, JSON.stringify(message));
  }
  message(id: string): Message | undefined {
    const row = this.db.prepare('SELECT document FROM messages WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(String(row.document)) as Message : undefined;
  }
  events(runId?: string): RunEvent[] {
    const rows = (runId
      ? this.db.prepare('SELECT sequence, document FROM events WHERE run_id=? ORDER BY sequence').all(runId)
      : this.db.prepare('SELECT sequence, document FROM (SELECT sequence, document FROM events ORDER BY sequence DESC LIMIT 2000) ORDER BY sequence').all()) as Row[];
    return rows.map(row => ({ ...JSON.parse(String(row.document)), sequence: Number(row.sequence) }) as RunEvent);
  }
  chatEvents(conversationId: string, runId: string, afterSequence: number): ChatEventsResult {
    const runRow = this.db.prepare('SELECT conversation_id, document FROM runs WHERE id=?').get(runId) as (Row & { conversation_id?: string }) | undefined;
    if (!runRow) throw new Error('Run does not exist.');
    if (String(runRow.conversation_id) !== conversationId) throw new Error('Run does not belong to this conversation.');
    const run = JSON.parse(String(runRow.document)) as Run;
    const rows = this.db.prepare('SELECT sequence, document FROM events WHERE run_id=? AND sequence>? ORDER BY sequence').all(runId, afterSequence) as Row[];
    const events = rows.map(row => ({ ...JSON.parse(String(row.document)), sequence: Number(row.sequence) }) as RunEvent);
    return { run, events };
  }
  append(run: Run, type: string, summary: string, data: Record<string, unknown> = {}): void {
    const event = { runId: run.id, projectId: run.projectId, conversationId: run.conversationId, at: new Date().toISOString(), type, summary, data };
    this.db.prepare('INSERT INTO events(run_id, document) VALUES (?, ?)').run(run.id, JSON.stringify(event));
  }
  runDirectory(run: Run): string {
    return join(this.root, 'projects', run.projectId, 'runs', `${run.createdAt.slice(0, 10).replaceAll('-', '')}_${run.id}`);
  }
  exportRun(run: Run): void {
    const dir = this.runDirectory(run);
    mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    const events = this.events(run.id);
    this.replace(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...run, harness: run.harness ?? 'codex', executionMode: run.executionMode ?? 'read-only', configuration: { harness: run.harness ?? 'codex', model: run.model, effort: run.effort } }, null, 2) + '\n');
    this.replace(join(dir, 'logs', 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
    this.replace(join(dir, 'logs', 'activity.log'), events.map(event => `${event.at} #${event.sequence} ${event.type} ${event.summary}\n`).join(''));
  }
  private replace(path: string, text: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  }
  snapshot(): WorkspaceSnapshot {
    return { projects: this.projects(), conversations: this.conversations(), runs: this.runs(), messages: this.messages(), events: this.events(), reviews: this.reviews(), dataRoot: this.root };
  }
  close(): void { this.db.close(); }
}
