import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Journal } from './evidence.js';
import { hash } from './codex.js';

type Json = Record<string, any>;
export type ScriptedCall = { id: string; command: string; cwd: string; escalated: boolean };
export function scriptedToolResponse(call: ScriptedCall): string {
  const args = { command: call.command, workdir: call.cwd, timeout_ms: 5_000,
    ...(call.escalated ? { sandbox_permissions: 'require_escalated', justification: 'Authorized disposable fixture permission test' } : {}) };
  return sse(call.id, { type: 'function_call', call_id: call.id, name: 'shell_command', arguments: JSON.stringify(args) });
}
function sse(id: string, item: Json): string {
  return [
    { type: 'response.created', response: { id: `response-${id}` } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: `response-${id}`, usage: {
      input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export class ScriptedServer {
  private server?: Server;
  private call?: ScriptedCall;
  private phase = 0;
  readonly requests: Json[] = [];
  readonly errors: string[] = [];
  endpoint = '';

  constructor(readonly journal: Journal) {}
  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.authorization || request.headers['api-key']) {
          throw new Error('Unexpected request route or authentication header');
        }
        let text = '';
        for await (const bytes of request) {
          text += bytes.toString();
          if (Buffer.byteLength(text) > 2_000_000) throw new Error('Request exceeds fixture limit');
        }
        const body = JSON.parse(text);
        if (!this.call || this.phase > 1 || body.model !== 'mock-model') throw new Error('Unscheduled response request');
        const output = Array.isArray(body.input) ? body.input.findLast((item: Json) => item.type === 'function_call_output' && item.call_id === this.call?.id) : undefined;
        if (this.phase === 1 && !output) throw new Error('Missing correlated real tool result');
        const receipt = { callId: this.call.id, phase: this.phase, authorizationPresent: false,
          inputDigest: hash(text), toolResult: output ? { callId: output.call_id, output: output.output } : null };
        this.requests.push(receipt);
        this.journal.append('scripted.http', 'Loopback Responses exchange', receipt);
        const bodyText = this.phase === 0 ? scriptedToolResponse(this.call) : sse(`${this.call.id}-final`, {
          id: `message-${this.call.id}`, type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Scripted fixture response complete.' }] });
        this.phase++;
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        response.end(bodyText);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Invalid fixture request';
        this.errors.push(reason);
        this.journal.append('scripted.rejected', 'Unexpected local request rejected', { reason });
        response.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: { message: reason, type: 'invalid_request_error' } }));
      }
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  prepare(call: ScriptedCall): void {
    if (this.call && this.phase !== 2) throw new Error('Previous scripted exchange incomplete');
    this.call = call;
    this.phase = 0;
    this.journal.append('scripted.call', 'Prepared exact native tool call', { ...call, tool: 'shell_command' });
  }
  complete(): boolean { return this.phase === 2 && this.errors.length === 0; }
  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }
}
