import type {
  HarnessId,
  HarnessInfo,
  HarnessInstallation,
  HarnessModel,
} from '@randolph/runtime/contracts';

type Props = {
  harnessId: HarnessId;
  executable: string;
  installations: HarnessInstallation[];
  harness: HarnessInfo | undefined;
  model: string;
  effort: string;
  selectedModel: HarnessModel | undefined;
  busy: boolean;
  onHarnessChange: (harnessId: HarnessId) => void;
  onExecutableChange: (executable: string) => void;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: string) => void;
};

export default function HarnessSelectionFields({
  harnessId,
  executable,
  installations,
  harness,
  model,
  effort,
  selectedModel,
  busy,
  onHarnessChange,
  onExecutableChange,
  onModelChange,
  onEffortChange,
}: Props) {
  return (
    <div className="settings-fields">
      <label>
        Harness
        <select
          value={harnessId}
          disabled={busy}
          onChange={(event) => onHarnessChange(event.target.value as HarnessId)}
        >
          <option value="codex">Codex · ChatGPT subscription</option>
          <option value="grok">Grok · compatibility pending</option>
        </select>
      </label>
      <label>
        {harnessId === 'grok' ? 'Grok CLI' : 'Codex CLI'}
        <select
          value={executable}
          disabled={busy}
          onChange={(event) => onExecutableChange(event.target.value)}
        >
          <option value="">Automatic discovery</option>
          {executable && !installations.some((item) => item.executable === executable) ? (
            <option value={executable}>{executable} (unavailable)</option>
          ) : null}
          {installations.map((item) => (
            <option key={item.executable} value={item.executable}>
              {item.version ?? 'Unavailable'} · {item.executable}
            </option>
          ))}
        </select>
      </label>
      <p>
        {harness?.executable ? (
          <>
            <code>{harness.executable}</code>
            <br />
            {harness.version} ·{' '}
            {harness.executionModes?.includes('code')
              ? 'Read-only and Code'
              : harness.executionModes?.includes('read-only')
                ? 'Read-only; Code compatibility unverified'
                : 'Execution compatibility pending'}
          </>
        ) : (
          (harness?.reason ?? 'Checking the selected CLI…')
        )}
      </p>
      {harness?.executionModes?.length === 0 && harness.reason ? <p>{harness.reason}</p> : null}
      <label>
        Default model
        <select
          value={model}
          disabled={busy || !harness?.available}
          onChange={(event) => onModelChange(event.target.value)}
        >
          {!selectedModel ? (
            <option value={model}>
              {model ? `${model} (unavailable)` : 'No models available'}
            </option>
          ) : null}
          {harness?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Default reasoning effort
        <select
          value={effort}
          disabled={busy || !selectedModel}
          onChange={(event) => onEffortChange(event.target.value)}
        >
          {!selectedModel?.efforts.includes(effort) ? (
            <option value={effort}>
              {effort ? `${effort} (unavailable)` : 'No effort available'}
            </option>
          ) : null}
          {selectedModel?.efforts.map((item) => (
            <option key={item} value={item}>
              {item} effort
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
