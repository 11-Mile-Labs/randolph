import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { object, text, type Json, type Pending } from './grok-shared.js';

export class AcpClient {
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = '';
  error?: Error;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeout: number,
    private notification: (message: Json) => void,
    private read?: (params: Json) => Json,
    private denied?: (method: string) => void,
    private write?: (params: Json) => Json,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.error) return;
      this.buffer += chunk;
      try {
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          if (index > 1_048_576) throw new Error('Grok returned an oversized ACP record.');
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          if (line.trim()) this.receive(object(JSON.parse(line)));
        }
        if (this.buffer.length > 1_048_576)
          throw new Error('Grok returned an oversized ACP record.');
      } catch {
        this.fail(new Error('Grok returned invalid ACP output.'));
      }
    });
    child.stderr.on('data', () => {
      /* Native diagnostics can include account information; do not retain them. */
    });
    child.once('error', () => this.fail(new Error('Grok could not start.')));
    child.once('close', () => this.fail(new Error('Grok transport closed.')));
  }
  private receive(message: Json): void {
    if (this.error) return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (message.method === 'session/request_permission')
          this.send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        else if (
          (message.method === 'fs/read_text_file' && this.read) ||
          (message.method === 'fs/write_text_file' && this.write)
        ) {
          try {
            const handler = message.method === 'fs/read_text_file' ? this.read! : this.write!;
            this.send({ id: message.id, result: handler(object(message.params)) });
          } catch {
            this.denied?.(message.method);
            this.send({
              id: message.id,
              error: {
                code: -32602,
                message: 'Filesystem request is outside the approved scope or unsupported.',
              },
            });
          }
        } else {
          this.denied?.(message.method);
          this.send({
            id: message.id,
            error: { code: -32601, message: 'Randolph does not authorize this operation.' },
          });
        }
      } else {
        try {
          this.notification(message);
        } catch (cause) {
          this.fail(cause instanceof Error ? cause : new Error('Grok session validation failed.'));
        }
      }
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new Error(
          `Grok request failed (${text(object(message.error).message, 200) || 'native error'}).`,
        ),
      );
    else pending.resolve(object(message.result));
  }
  send(message: Json): void {
    if (this.error) throw this.error;
    if (!this.child.stdin.writable) throw new Error('Grok transport closed.');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  rpc(method: string, params: Json, timeout = this.timeout): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Grok request timed out: ${method}. Inspect retained activity before retrying.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(cause);
      }
    });
  }
  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
