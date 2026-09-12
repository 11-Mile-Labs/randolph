import type { Run } from './contracts.js';
import type { DelegationSnapshot, DelegationRevisionInput, ReviseDelegationInput, SaveDelegationPresetInput } from './delegation-contracts.js';
import { DelegationRecords, type DelegationPlanRevision } from './delegation-records.js';
import { parseDelegationDraft, parseDelegationPlan, readDelegationSettings, validateDelegationPlan, writeDelegationSettings, type DelegationAvailability } from './delegation-plan.js';
import { Store } from './store.js';
import { createHash } from 'node:crypto';

export type DelegationCommandPolicy = {
  assertMutable: (run: Run) => void;
  assertBasis: (run: Run, plan: DelegationPlanRevision) => void;
  availability: (run: Run, plan: DelegationPlanRevision) => Promise<DelegationAvailability>;
  // The scheduler supplies this only when it can admit the retained task graph.
  execution?: { assertReady: (run: Run) => void; queued: (runId: string) => void };
};
const failure = (cause: unknown): string => cause instanceof Error ? cause.message : 'Delegation validation failed.';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const settingsDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export class DelegationCommands {
  readonly records: DelegationRecords;
  private readonly pending = new Set<string>();
  constructor(private readonly store: Store, private readonly policy: DelegationCommandPolicy, private readonly changed: () => void) { this.records = new DelegationRecords(store); }
  private run(id: string): Run { const run = this.store.runs().find(run => run.id === id); if (!run) throw new Error('Delegation run does not exist.'); return run; }
  private root(run: Run): string { const project = this.store.projects().find(project => project.id === run.projectId); if (!project) throw new Error('Delegation project does not exist.'); return project.root; }
  private exact(input: DelegationRevisionInput): DelegationPlanRevision {
    const latest = this.records.plans(input.runId).at(-1);
    if (!latest || latest.id !== input.planId || latest.digest !== input.digest || latest.basisDigest !== input.basisDigest || !['draft', 'ready'].includes(latest.disposition)) throw new Error('This proposal changed or is no longer actionable. Reload its latest revision.');
    return latest;
  }
  private check(run: Run, plan: DelegationPlanRevision, availability: DelegationAvailability): string[] {
    const errors = validateDelegationPlan(plan.plan, availability).errors;
    try { this.policy.assertBasis(run, plan); } catch (cause) { errors.push(failure(cause)); }
    return errors;
  }
  private pendingPresetSaves(runId: string) {
    const events = this.store.events(runId);
    const settled = new Set(events.filter(event => ['delegation.preset-saved', 'delegation.preset-save-superseded'].includes(event.type)).map(event => event.data.intentSequence));
    return events.filter(event => event.type === 'delegation.preset-save-intent' && !settled.has(event.sequence));
  }
  private completePresetSave(run: Run, intent: ReturnType<DelegationCommands['pendingPresetSaves']>[number], settingsRevision: string | null, reconciled: boolean): void {
    const { planId, digest, basisDigest, preset } = intent.data;
    if (typeof planId !== 'string' || typeof digest !== 'string' || typeof basisDigest !== 'string' || !preset || typeof preset !== 'object' || !('id' in preset) || typeof preset.id !== 'string') throw new Error('Retained preset-save intent is incomplete.');
    const presetId = preset.id;
    this.store.transaction(() => {
      if (!this.records.presetSaves(run.id).some(save => save.planId === planId && save.presetId === presetId && save.digest === digest && save.basisDigest === basisDigest)) this.records.recordPresetSave({ runId: run.id, planId, digest, basisDigest, presetId });
      this.store.append(run, 'delegation.preset-saved', reconciled ? 'The saved preset receipt was reconciled without rewriting settings.' : 'Delegation preset saved without authorizing execution.', { intentSequence: intent.sequence, planId, presetId: preset.id, settingsRevision, reconciled });
    });
  }
  private reconcilePresetSaves(run: Run, settings: DelegationSnapshot['settings']): string[] {
    const warnings: string[] = [];
    for (const intent of this.pendingPresetSaves(run.id)) {
      if (!settings.error && intent.data.targetSettingsDigest === settingsDigest(settings.value)) {
        try { this.completePresetSave(run, intent, settings.revision, true); }
        catch { warnings.push('A preset exists on disk, but its save receipt remains unconfirmed. Reload to retry reconciliation.'); }
      } else warnings.push('A prior preset save is unconfirmed because the settings no longer match its intended result. Inspect the current preset before choosing whether to save again.');
    }
    return [...new Set(warnings)];
  }
  async snapshot(runId: string): Promise<DelegationSnapshot> {
    const run = this.run(runId), plans = this.records.plans(runId), plan = plans.at(-1), settings = readDelegationSettings(this.root(run));
    const presetSaveWarnings = this.reconcilePresetSaves(run, settings);
    const blockedReasons: string[] = [], validationErrors: string[] = [];
    let canEdit = Boolean(plan && ['draft', 'ready'].includes(plan.disposition));
    try { this.policy.assertMutable(run); } catch (cause) { blockedReasons.push(failure(cause)); canEdit = false; }
    if (this.pending.has(runId)) { blockedReasons.push('A proposal decision is being recorded.'); canEdit = false; }
    if (plan) {
      try { validationErrors.push(...this.check(run, plan, await this.policy.availability(run, plan))); } catch (cause) { validationErrors.push(failure(cause)); }
      if (plan.disposition === 'draft') blockedReasons.push('This draft is not ready for approval. Resolve its validation errors and prepare its source basis.');
    }
    if (!this.policy.execution) blockedReasons.push('Worker execution is not enabled in this build.');
    else try { this.policy.execution.assertReady(run); } catch (cause) { blockedReasons.push(failure(cause)); }
    // Discovery can yield to a newer proposal or another run action.
    const current = this.records.plans(runId).at(-1);
    if (current?.id !== plan?.id || current?.disposition !== plan?.disposition) { canEdit = false; blockedReasons.push('The proposal changed during validation. Refresh before deciding.'); }
    try { this.policy.assertMutable(this.run(runId)); } catch (cause) { canEdit = false; blockedReasons.push(failure(cause)); }
    return { runId, plan, history: plans.map(({ id, revision, disposition, createdAt }) => ({ id, revision, disposition, createdAt })), tasks: this.records.tasks(runId), validationErrors, blockedReasons: [...new Set(blockedReasons)], canEdit, canApprove: canEdit && plan?.disposition === 'ready' && !validationErrors.length && !blockedReasons.length, settings, presetSaveWarnings };
  }
  private async decision(input: DelegationRevisionInput, action: (run: Run, plan: DelegationPlanRevision) => Promise<void> | void): Promise<DelegationSnapshot> {
    if (this.pending.has(input.runId)) throw new Error('A proposal decision is already in progress.');
    this.pending.add(input.runId);
    try { const run = this.run(input.runId); this.policy.assertMutable(run); await action(run, this.exact(input)); }
    finally { this.pending.delete(input.runId); this.changed(); }
    return this.snapshot(input.runId);
  }
  revise(input: ReviseDelegationInput): Promise<DelegationSnapshot> {
    return this.decision(input, (run, prior) => {
      const revision = prior.revision + 1, plan = parseDelegationDraft({ ...input.plan, revision });
      this.records.recordPlan({ runId: run.id, revision, requestId: prior.requestId, source: prior.source, basis: prior.basis, plan });
      // Editing a settled proposal keeps its retained basis, but never promotes an invalid graph.
      try { parseDelegationPlan(plan); this.policy.assertBasis(run, prior); } catch { return; }
      const recorded = this.records.plans(run.id).at(-1)!;
      this.records.readyPlan({ runId: run.id, planId: recorded.id, digest: recorded.digest, basisDigest: recorded.basisDigest });
    });
  }
  reject(input: DelegationRevisionInput): Promise<DelegationSnapshot> {
    return this.decision(input, (run, plan) => {
      this.store.transaction(() => { plan.disposition = 'rejected'; this.store.db.prepare('UPDATE delegation_plans SET document=? WHERE id=?').run(JSON.stringify(plan), plan.id); this.store.append(run, 'delegation.rejected', 'Delegation proposal rejected.', { planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest }); });
    });
  }
  approve(input: DelegationRevisionInput): Promise<DelegationSnapshot> {
    return this.decision(input, async (run, plan) => {
      if (!this.policy.execution) throw new Error('Worker execution is not enabled in this build.');
      this.policy.execution.assertReady(run);
      const availability = await this.policy.availability(run, plan);
      const currentRun = this.run(run.id), current = this.exact(input);
      this.policy.assertMutable(currentRun); this.policy.execution.assertReady(currentRun);
      const errors = this.check(currentRun, current, availability);
      if (errors.length) throw new Error(errors.join(' '));
      this.store.transaction(() => { const authorization = this.records.authorize({ ...input, decision: 'user', presetSaved: this.records.presetSaves(run.id).some(save => save.planId === plan.id) }); this.records.createTasks({ runId: run.id, authorizationId: authorization.id }); });
      this.policy.execution.queued(run.id);
    });
  }
  savePreset(input: SaveDelegationPresetInput): Promise<DelegationSnapshot> {
    return this.decision(input, (run, plan) => {
      const settings = readDelegationSettings(this.root(run));
      if (settings.error) throw new Error(settings.error);
      if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId) || !input.name.trim() || input.name.length > 120 || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Enter a valid preset ID and name.');
      const matching = this.store.events(run.id).findLast(event => {
        const preset = event.data.preset as { id?: unknown; name?: unknown } | undefined;
        return event.type === 'delegation.preset-save-intent' && event.data.planId === plan.id && event.data.digest === plan.digest && event.data.basisDigest === plan.basisDigest && event.data.expectedSettingsRevision === input.expectedSettingsRevision && preset?.id === input.presetId && preset.name === input.name && event.data.targetSettingsDigest === settingsDigest(settings.value);
      });
      if (matching) {
        if (this.pendingPresetSaves(run.id).some(intent => intent.sequence === matching.sequence)) this.completePresetSave(run, matching, settings.revision, true);
        return;
      }
      if (settings.revision !== input.expectedSettingsRevision) throw new Error('Delegation settings changed. Reload before saving a preset.');
      const concrete = parseDelegationPlan(plan.plan), previous = settings.value.presets.find(preset => preset.id === input.presetId);
      const preset = { id: input.presetId, name: input.name, revision: (previous?.revision ?? 0) + 1, plan: concrete };
      const value = { ...settings.value, presets: [...settings.value.presets.filter(item => item.id !== input.presetId), preset] };
      this.store.append(run, 'delegation.preset-save-intent', 'Saving this exact proposal as a preset; execution is not authorized.', { planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest, preset, expectedSettingsRevision: settings.revision, targetSettingsDigest: settingsDigest(value) });
      const intent = this.pendingPresetSaves(run.id).at(-1)!;
      const saved = writeDelegationSettings(this.root(run), value, settings.revision);
      try {
        this.completePresetSave(run, intent, saved.revision, false);
        for (const prior of this.pendingPresetSaves(run.id)) if (prior.sequence !== intent.sequence && (prior.data.preset as { id?: unknown } | undefined)?.id === preset.id) this.store.append(run, 'delegation.preset-save-superseded', 'A new explicit preset save superseded an earlier unconfirmed intent.', { intentSequence: prior.sequence, replacementIntentSequence: intent.sequence });
      } catch { throw new Error('The preset was written, but its save receipt is unconfirmed. Reload to reconcile before retrying.'); }
    });
  }
}
