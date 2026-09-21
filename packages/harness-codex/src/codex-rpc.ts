import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { MAX_LINE, object, type Json, type Pending } from './codex-shared.js';

export class RpcClient {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = '';
  error?: Error;
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly timeout: number,
    readonly notification: (message: Json) => boolean | void,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.on('data', () => {
      /* Harness diagnostics may contain account details; never retain them. */
    });
    child.once('error', () => this.fail(new Error('Codex process could not start.')));
    child.once('close', () => this.fail(new Error('Codex transport closed.')));
  }
  private read(chunk: string): void {
    if (this.error) return;
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > MAX_LINE) {
        this.fail(new Error('Codex JSON-RPC message exceeded the size limit.'));
        return;
      }
      if (line.trim()) {
        try {
          this.receive(object(JSON.parse(line)));
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error('Codex emitted invalid JSON.'));
          return;
        }
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE) {
      this.buffer = '';
      this.fail(new Error('Codex JSON-RPC message exceeded the size limit.'));
    }
  }
  private receive(message: Json): void {
    if (typeof message.method === 'string') {
      const handled = this.notification(message);
      if ('id' in message && !handled) {
        if (message.method === 'item/permissions/requestApproval')
          this.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
        else if (
          ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
            message.method,
          )
        )
          this.send({ id: message.id, result: { decision: 'decline' } });
        else
          this.send({
            id: message.id,
            error: { code: -32601, message: 'Unsupported native request declined by Randolph.' },
          });
      }
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error)
      pending.reject(
        new Error(`Codex RPC failed (code ${String(object(message.error).code ?? 'unknown')}).`),
      );
    else pending.resolve(object(message.result));
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
  send(message: Json): void {
    if (this.error) throw this.error;
    if (!this.child.stdin.writable) throw new Error('Codex transport closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  rpc(method: string, params: Json, timeout = this.timeout): Promise<Json> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}
