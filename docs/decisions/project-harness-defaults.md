# Project harness defaults

Status: implemented as a follow-up to the [first desktop slice](desktop-first-slice.md). Codex supports execution; Grok discovery and selection are available, with execution still gated on native compatibility. The subsequent [controlled coding slice](controlled-coding.md) adds execution modes and local delivery.

## Settings and authority

Open **Project settings** from Workspace, the sidebar, or a conversation to select the project's harness and CLI, default model, and reasoning effort. Save writes `config.harness.yaml` in the registered project root. The file is optional, editable outside Randolph, and suitable for version control:

```yaml
schemaVersion: 1
harness: codex
model: your-installed-model-id
effort: your-supported-effort
executable: null # automatic discovery; an explicit choice stores an absolute path
```

The example values are placeholders. The app lists the models and efforts reported by the installed, authenticated Codex CLI and validates the selection again before saving or running. No native user configuration is imported or modified.

The YAML file is authoritative for project defaults. SQLite retains conversation overrides and immutable run records. Changing either model picker in the composer saves an override immediately, including before the first message. **Use project default** clears the override. Existing conversations with a previously saved model/effort keep those selections as overrides; untouched new conversations inherit project defaults. Projects without a settings file initially use the first native-reported model and its reported default effort.

## Installed CLI selection

Discovery inventories installed Codex executables across PATH and standard installation locations, resolves symlinks, and lists distinct paths with their versions. Application Settings shows the automatically discovered executable. Choosing a CLI for execution belongs to each project's settings; it does not edit the shell PATH, remove launchers, or alter another project. **Automatic discovery** clears an explicit choice.

The project editor refreshes subscription readiness, models, efforts, and supported execution modes from the selected copy before saving. CLI changes can expose different model catalogs. Missing saved executables remain visible and prevent dispatch until corrected; no alternative executable or API is substituted. Inventories and readiness checks do not start model turns. Grok has an independent discovered CLI catalog and remains blocked from execution until its native compatibility requirements pass.

## Project execution permissions

**Set project CLI permissions** in Project settings creates an explicit `enabledRoutes` list. Each checkbox authorizes one exact harness and executable path; discovering an executable does not enable it. The editor initially includes only the currently selected main CLI. Switch the harness selector to inspect other installed CLIs; enabled entries from other harnesses remain visible.

```yaml
enabledRoutes:
  - harness: codex
    executable: /absolute/path/to/codex
```

An empty list blocks all new execution. Existing files without the list preserve their selected-main behavior; a run retains only that selected CLI as its legacy authorization for future delegation. Saving model defaults without supplying new permissions preserves the existing list. Invalid routes, duplicates, and relative paths are rejected.

New sends, setup inspections, and linked restart/rerun admissions verify the exact discovered CLI against the current list. Changes or unreadable settings encountered during discovery block admission. Runs retain the authorized routes and their configuration revision separately from model-default provenance. Settings changes affect new runs, while an existing run and its checks keep their frozen route. Active-run revocation will be a separate recorded control in the delegation scheduler; editing this file does not terminate active work.

## Run behavior

At dispatch, the runtime reads current project settings and resolves the conversation override, project default, or initial native choice in that order. Every new run retains its resolved executable path and reported version, exact model, effort, settings source, and project configuration revision in its record, manifest, and initial event. Later settings changes apply to new runs only. Review checks use the executable recorded for their run. Linked checkpoint execution retains the recorded CLI identity when present; a missing executable or changed reported version blocks execution instead of silently switching. Historical records created before executable tracking have no retained CLI identity and use discovery. Paths and reported versions are recorded; this is not a cryptographic binary pin. Viewing settings or reopening history never starts a model turn.

Unavailable saved models or efforts remain visible rather than being silently replaced. Sending is blocked until the user selects an available override or updates the project defaults. Malformed project YAML blocks new dispatches for that project while history remains accessible.

## External edits and errors

Settings are refreshed with workspace snapshots, on window focus, when selecting a conversation, and through **Reload settings**. An open settings editor retains the revision it originally loaded. Saving compares the raw file hash and rejects an observed external change rather than overwriting it. Reloading explicitly discards that editor's unsaved selection. The runtime also reads settings again before dispatch, so it never dispatches from a stale cached default.

Writes use a bounded YAML parser and an exclusive temporary file followed by atomic replacement, preserving comments and unrelated keys. Unsupported schema versions, duplicate keys, unsupported tags, aliases, oversized files, linked/nonregular files, and redirected project directories are rejected. Invalid files must be corrected externally before saving through the UI.

Atomic replacement prevents partial-file publication. Revision checks do not supply a filesystem compare-and-swap guarantee against an external program modifying the file during the final check-to-rename interval. There is no continuous file watcher in this slice.

## Verification and remaining scope

A separate Electron acceptance test selects between two scripted CLI copies with different model catalogs, proves dispatch uses the selected copy, reopens settings, and clears the choice without another model turn, saves explicit empty permissions, and verifies that a disabled CLI cannot launch. Runtime tests prove later project changes cannot redirect a run’s review checks. Adapter tests reject a changed reported version before dispatch.

Runtime and filesystem tests cover reopen without execution, unsent overrides, inheritance/reset, external changes, immutable run settings, unavailable models, invalid files, and stale-save rejection. The Electron test saves project defaults, sends one scripted turn, persists two conversation overrides, closes/reopens, resets inheritance, and rejects a stale settings save. It uses a scripted CLI and consumes no model inference.

Full project configuration management, additional harnesses, guided setup, context selection, and workflow/delegation configuration remain later capabilities. This implementation does not change final delivery, lifecycle, or sandbox boundaries.
