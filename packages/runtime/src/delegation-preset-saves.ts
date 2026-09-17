import type { Run, RunEvent } from './contracts.js';
import type { DelegationSnapshot, SaveDelegationPresetInput } from './delegation-contracts.js';
import { DelegationRecords, type DelegationPlanRevision } from './delegation-records.js';
import {
  parseDelegationPlan,
  readDelegationSettings,
  writeDelegationSettings,
} from './delegation-plan.js';
import { Store } from './store.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

const settingsDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');

/** The preset-save saga: intent discovery, the file-plus-SQLite receipt, and crash reconciliation. Saving a preset never authorizes execution. */
export class DelegationPresetSaves {
  constructor(
    private readonly store: Store,
    private readonly records: DelegationRecords,
    private readonly root: (run: Run) => string,
  ) {}
  private pendingPresetSaves(runId: string) {
    const events = this.store.events(runId);
    const settled = new Set(
      events
        .filter((event) =>
          ['delegation.preset-saved', 'delegation.preset-save-superseded'].includes(event.type),
        )
        .map((event) => event.data.intentSequence),
    );
    return events.filter(
      (event) => event.type === 'delegation.preset-save-intent' && !settled.has(event.sequence),
    );
  }
  private completePresetSave(
    run: Run,
    intent: RunEvent,
    settingsRevision: string | null,
    reconciled: boolean,
  ): void {
    const { planId, digest, basisDigest, preset } = intent.data;
    if (
      typeof planId !== 'string' ||
      typeof digest !== 'string' ||
      typeof basisDigest !== 'string' ||
      !preset ||
      typeof preset !== 'object' ||
      !('id' in preset) ||
      typeof preset.id !== 'string'
    )
      throw new Error('Retained preset-save intent is incomplete.');
    const presetId = preset.id;
    this.store.transaction(() => {
      if (
        !this.records
          .presetSaves(run.id)
          .some(
            (save) =>
              save.planId === planId &&
              save.presetId === presetId &&
              save.digest === digest &&
              save.basisDigest === basisDigest,
          )
      )
        this.records.recordPresetSave({ runId: run.id, planId, digest, basisDigest, presetId });
      this.store.append(
        run,
        'delegation.preset-saved',
        reconciled
          ? 'The saved preset receipt was reconciled without rewriting settings.'
          : 'Delegation preset saved without authorizing execution.',
        {
          intentSequence: intent.sequence,
          planId,
          presetId: preset.id,
          settingsRevision,
          reconciled,
        },
      );
    });
  }
  reconcile(run: Run, settings: DelegationSnapshot['settings']): string[] {
    const warnings: string[] = [];
    for (const intent of this.pendingPresetSaves(run.id)) {
      if (!settings.error && intent.data.targetSettingsDigest === settingsDigest(settings.value)) {
        try {
          this.completePresetSave(run, intent, settings.revision, true);
        } catch {
          warnings.push(
            'A preset exists on disk, but its save receipt remains unconfirmed. Reload to retry reconciliation.',
          );
        }
      } else
        warnings.push(
          'A prior preset save is unconfirmed because the settings no longer match its intended result. Inspect the current preset before choosing whether to save again.',
        );
    }
    return [...new Set(warnings)];
  }
  save(run: Run, plan: DelegationPlanRevision, input: SaveDelegationPresetInput): void {
    const settings = readDelegationSettings(this.root(run));
    if (settings.error) throw new Error(settings.error);
    if (
      !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId) ||
      !input.name.trim() ||
      input.name.length > 120 ||
      Array.from(input.name).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error('Enter a valid preset ID and name.');
    const matching = this.store.events(run.id).findLast((event) => {
      const preset = event.data.preset as { id?: unknown; name?: unknown } | undefined;
      return (
        event.type === 'delegation.preset-save-intent' &&
        event.data.planId === plan.id &&
        event.data.digest === plan.digest &&
        event.data.basisDigest === plan.basisDigest &&
        event.data.expectedSettingsRevision === input.expectedSettingsRevision &&
        preset?.id === input.presetId &&
        preset.name === input.name &&
        event.data.targetSettingsDigest === settingsDigest(settings.value)
      );
    });
    if (matching) {
      if (this.pendingPresetSaves(run.id).some((intent) => intent.sequence === matching.sequence))
        this.completePresetSave(run, matching, settings.revision, true);
      return;
    }
    if (settings.revision !== input.expectedSettingsRevision)
      throw new Error('Delegation settings changed. Reload before saving a preset.');
    const concrete = parseDelegationPlan(plan.plan),
      previous = settings.value.presets.find((preset) => preset.id === input.presetId);
    const preset = {
      id: input.presetId,
      name: input.name,
      revision: (previous?.revision ?? 0) + 1,
      plan: concrete,
    };
    const value = {
      ...settings.value,
      presets: [...settings.value.presets.filter((item) => item.id !== input.presetId), preset],
    };
    this.store.append(
      run,
      'delegation.preset-save-intent',
      'Saving this exact proposal as a preset; execution is not authorized.',
      {
        planId: plan.id,
        digest: plan.digest,
        basisDigest: plan.basisDigest,
        preset,
        expectedSettingsRevision: settings.revision,
        targetSettingsDigest: settingsDigest(value),
      },
    );
    const intent = this.pendingPresetSaves(run.id).at(-1)!;
    const saved = writeDelegationSettings(this.root(run), value, settings.revision);
    try {
      this.completePresetSave(run, intent, saved.revision, false);
      for (const prior of this.pendingPresetSaves(run.id))
        if (
          prior.sequence !== intent.sequence &&
          (prior.data.preset as { id?: unknown } | undefined)?.id === preset.id
        )
          this.store.append(
            run,
            'delegation.preset-save-superseded',
            'A new explicit preset save superseded an earlier unconfirmed intent.',
            { intentSequence: prior.sequence, replacementIntentSequence: intent.sequence },
          );
    } catch {
      throw new Error(
        'The preset was written, but its save receipt is unconfirmed. Reload to reconcile before retrying.',
      );
    }
  }
}
