import { now } from './runtime-status.js';
import type { RuntimeBindings } from './runtime-bindings.js';

export async function stopRun(host: Pick<RuntimeBindings, 'active' | 'store' | 'changed'>, runId: string): Promise<void> {
  const state = host.active.get(runId);
  if (!state) return;
  const run = state.run;
  run.status = 'stopping'; run.updatedAt = now();
  host.store.transaction(() => { host.store.putRun(run); host.store.append(run, 'run.stopping', `Stopping ${run.harness ?? 'codex'}; awaiting confirmation`); });
  host.changed(); state.controller.abort(); await state.done;
}

export function hasActiveWork(host: Pick<RuntimeBindings, 'nativeAdmission' | 'active' | 'admission' | 'reviews' | 'pushes'>, options: { includeDiscovery?: boolean } = {}): boolean {
  return host.nativeAdmission.hasActiveWork(options.includeDiscovery !== false) || host.active.size > 0 || host.admission.size > 0 || host.reviews.hasActiveWork() || host.pushes.hasActiveWork();
}

export async function stopAllWork(host: Pick<RuntimeBindings, 'nativeAdmission' | 'pushes' | 'active' | 'store' | 'reviews' | 'changed'>): Promise<void> {
  await host.nativeAdmission.stopAll();
  await host.pushes.stopAll();
  await Promise.all([...host.active.keys()].map(id => stopRun(host, id)));
  await Promise.all(host.store.reviews().filter(review => review.status === 'checking').map(review => host.reviews.stop(review.id)));
}

export async function closeRuntime(host: RuntimeBindings): Promise<void> {
  host.accepting = false;
  await host.nativeAdmission.close();
  await host.workspaces.wait();
  await host.pushes.close();
  await host.reviews.close();
  await Promise.all([...host.active.keys()].map(id => stopRun(host, id)));
  host.store.close();
}
