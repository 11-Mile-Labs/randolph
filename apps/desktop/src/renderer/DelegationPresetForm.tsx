type Props = {
  presetId: string;
  presetName: string;
  warnings?: string[];
  disabled: boolean;
  saveDisabled: boolean;
  saving: boolean;
  onPresetIdChange: (value: string) => void;
  onPresetNameChange: (value: string) => void;
  onSave: () => void;
};

export default function DelegationPresetForm({
  presetId,
  presetName,
  warnings,
  disabled,
  saveDisabled,
  saving,
  onPresetIdChange,
  onPresetNameChange,
  onSave,
}: Props) {
  return (
    <section className="delegation-preset" aria-label="Save named preset">
      <h4>Save a named preset</h4>
      <p>
        Saving retains this exact revision for later selection. It does not authorize execution.
      </p>
      {warnings?.length ? (
        <aside className="delegation-preset-warning" aria-label="Preset save recovery warnings">
          <strong>Preset save needs review</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </aside>
      ) : null}
      <label>
        Preset ID
        <input
          aria-label="Preset ID"
          value={presetId}
          disabled={disabled}
          onChange={(event) => onPresetIdChange(event.target.value)}
        />
      </label>
      <label>
        Preset name
        <input
          aria-label="Preset name"
          value={presetName}
          disabled={disabled}
          onChange={(event) => onPresetNameChange(event.target.value)}
        />
      </label>
      <button className="secondary-button" type="button" disabled={saveDisabled} onClick={onSave}>
        {saving ? 'Saving preset…' : 'Save preset'}
      </button>
    </section>
  );
}
