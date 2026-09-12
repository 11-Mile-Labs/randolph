import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation, Message, Project, Run, RunEvent, WorkspaceSnapshot } from './contracts.js';

type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'app.sqlite'));
    chmodSync(join(root, 'app.sqlite'), 0o600);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 1) { this.db.close(); throw new Error('This data directory was created by a newer Randolph version.'); }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
      PRAGMA user_version=1;`);
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projects(): Project[] { return this.documents('projects'); }
  conversations(): Conversation[] { return this.documents('conversations'); }
  runs(): Run[] { return this.documents('runs'); }
  private documents<T>(table: 'projects' | 'conversations' | 'runs' | 'messages'): T[] {
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
    this.replace(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...run, executionMode: 'read-only', configuration: { harness: 'codex', model: run.model, effort: run.effort } }, null, 2) + '\n');
    this.replace(join(dir, 'logs', 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
    this.replace(join(dir, 'logs', 'activity.log'), events.map(event => `${event.at} #${event.sequence} ${event.type} ${event.summary}\n`).join(''));
  }
  private replace(path: string, text: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  }
  snapshot(): WorkspaceSnapshot {
    return { projects: this.projects(), conversations: this.conversations(), runs: this.runs(), messages: this.documents('messages'), events: this.events(), dataRoot: this.root };
  }
  close(): void { this.db.close(); }
}
