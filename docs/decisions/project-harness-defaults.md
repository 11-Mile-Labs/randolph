# Project harness defaults

Status: implemented as a follow-up to the [first desktop slice](desktop-first-slice.md). The conversation harness remains Codex. The subsequent [controlled coding slice](controlled-coding.md) adds execution modes and local delivery.

## Settings and authority

Open **Project settings** from a conversation to select its project's default model and reasoning effort. Save writes `config.harness.yaml` in the registered project root. The file is optional, editable outside Randolph, and suitable for version control:

```yaml
schemaVersion: 1
harness: codex
model: your-installed-model-id
effort: your-supported-effort
```

The example values are placeholders. The app lists the models and efforts reported by the installed, authenticated Codex CLI and validates the selection again before saving or running. No native user configuration is imported or modified.

The YAML file is authoritative for project defaults. SQLite retains conversation overrides and immutable run records. Changing either model picker in the composer saves an override immediately, including before the first message. **Use project default** clears the override. Existing conversations with a previously saved model/effort keep those selections as overrides; untouched new conversations inherit project defaults. Projects without a settings file initially use the first native-reported model and its reported default effort.

## Run behavior

At dispatch, the runtime reads current project settings and resolves the conversation override, project default, or initial native choice in that order. Every run retains its exact model, effort, settings source, and project configuration revision in its record, manifest, and initial event. Later settings changes apply to new runs only. Viewing settings or reopening history never starts a model turn.

Unavailable saved models or efforts remain visible rather than being silently replaced. Sending is blocked until the user selects an available override or updates the project defaults. Malformed project YAML blocks new dispatches for that project while history remains accessible.

## External edits and errors

Settings are refreshed with workspace snapshots, on window focus, when selecting a conversation, and through **Reload settings**. An open settings editor retains the revision it originally loaded. Saving compares the raw file hash and rejects an observed external change rather than overwriting it. Reloading explicitly discards that editor's unsaved selection. The runtime also reads settings again before dispatch, so it never dispatches from a stale cached default.

Writes use a bounded YAML parser and an exclusive temporary file followed by atomic replacement, preserving comments and unrelated keys. Unsupported schema versions, duplicate keys, unsupported tags, aliases, oversized files, linked/nonregular files, and redirected project directories are rejected. Invalid files must be corrected externally before saving through the UI.

Atomic replacement prevents partial-file publication. Revision checks do not supply a filesystem compare-and-swap guarantee against an external program modifying the file during the final check-to-rename interval. There is no continuous file watcher in this slice.

## Verification and remaining scope

Runtime and filesystem tests cover reopen without execution, unsent overrides, inheritance/reset, external changes, immutable run settings, unavailable models, invalid files, and stale-save rejection. The Electron test saves project defaults, sends one scripted turn, persists two conversation overrides, closes/reopens, resets inheritance, and rejects a stale settings save. It uses a scripted CLI and consumes no model inference.

Full project configuration management, additional harnesses, guided setup, context selection, and workflow/delegation configuration remain later capabilities. This implementation does not change final delivery, lifecycle, or sandbox boundaries.
