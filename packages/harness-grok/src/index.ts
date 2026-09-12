import type { AdapterRun } from '@randolph/runtime/contracts';
import { GrokProtocol } from './protocol.js';
export type { GrokAdapterOptions } from './protocol.js';

export class GrokAdapter extends GrokProtocol {
  override async run(_input: AdapterRun): Promise<{ status: 'completed' | 'interrupted' | 'stop-unconfirmed' }> {
    throw new Error('Grok execution is unavailable: native file tools bypass the verified workspace boundary.');
  }
}
