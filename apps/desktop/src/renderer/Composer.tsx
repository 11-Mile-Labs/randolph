import type { FormEvent } from 'react';
import type { HarnessId, HarnessInfo, HarnessModel } from '@randolph/runtime/contracts';

export type ComposerProps = {
  harnessId: HarnessId;
  harness?: HarnessInfo;
  model: string;
  effort: string;
  value: string;
  disabled: boolean;
  settingsDisabled: boolean;
  sendBlocked: boolean;
  sending: boolean;
  onModelChange: (model: HarnessModel) => void;
  onHarnessChange: (harness: HarnessId) => void;
  onEffortChange: (effort: string) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function Composer({
  harnessId,
  harness,
  model,
  effort,
  value,
  disabled,
  settingsDisabled,
  sendBlocked,
  sending,
  onModelChange,
  onHarnessChange,
  onEffortChange,
  onValueChange,
  onSubmit,
}: ComposerProps) {
  const selectedModel = harness?.models.find((item) => item.id === model);
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        aria-label="Message"
        placeholder="Ask Randolph about this project…"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={disabled}
        rows={2}
      />
      <div className="composer-toolbar">
        <div className="selector-group">
          <label>
            <span className="sr-only">Harness</span>
            <select
              aria-label="Conversation harness"
              value={harnessId}
              disabled={settingsDisabled}
              onChange={(event) => onHarnessChange(event.target.value as HarnessId)}
            >
              <option value="codex">Codex</option>
              <option value="grok">Grok (compatibility pending)</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Model</span>
            <select
              value={model}
              disabled={settingsDisabled || !harness?.available}
              onChange={(event) => {
                const next = harness?.models.find((item) => item.id === event.target.value);
                if (next) onModelChange(next);
              }}
            >
              {!selectedModel ? (
                <option value={model}>
                  {model ? `${model} (unavailable)` : 'No models available'}
                </option>
              ) : null}
              {harness?.models.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Reasoning effort</span>
            <select
              value={effort}
              disabled={settingsDisabled || !selectedModel}
              onChange={(event) => onEffortChange(event.target.value)}
            >
              {!selectedModel?.efforts.includes(effort) ? (
                <option value={effort}>
                  {effort ? `${effort} (unavailable)` : 'No effort available'}
                </option>
              ) : null}
              {selectedModel?.efforts.map((item) => (
                <option value={item} key={item}>
                  {item} effort
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="send-button"
          type="submit"
          aria-label="Send message"
          disabled={
            disabled || sendBlocked || sending || value.trim().length === 0 || !model || !effort
          }
        >
          {sending ? (
            <span className="button-spinner" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 10 5-5 5 5M10 5v10" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
