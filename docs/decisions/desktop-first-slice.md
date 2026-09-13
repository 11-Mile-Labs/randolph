# First desktop product slice

Status: implemented developer slice; full v1 acceptance remains open. The subsequent [AI SDK transport integration](ai-sdk-chat-transport.md) replaces the original direct chat presentation described below; native execution and durable authority are preserved.

The subsequent [project harness defaults slice](project-harness-defaults.md) adds editable project settings and persisted conversation overrides. Statements below describe the original desktop boundary except where that follow-up or [controlled coding and delivery](controlled-coding.md) extends it.

## Product transition

Reusable product code belongs in `apps/desktop`, `packages/runtime`, and `packages/harness-codex`. Existing experiment programs retain version-specific probes and reproductions; product packages do not import them. New product behavior and its tests are developed in the product packages.

The first slice is useful read-only conversation about a selected local project. It creates projects and multiple conversations, discovers native subscription models and efforts, streams assistant text with visible activity, and retains history. It does not present coding or delivery controls that have not been implemented.

## Selected implementation

- Electron 44.3, React 19.3 and TypeScript 7.0.2, pinned in the workspace lockfile; macOS developer launch through `pnpm desktop`.
- Renderer communicates only through a typed preload bridge. Local assets use a private application protocol and restrictive CSP. Main-frame origin and command arguments are validated before privileged operations.
- Runtime modules execute in the desktop main process for this slice; the renderer is a separate process. A separate supervised runtime process and owner-loss mechanism are still unfinished.
- Installed Codex App Server over stdio supplies native account readiness, model/effort discovery, sessions and events. Every execution rechecks ChatGPT account mode. There is no API-key or gateway execution path.
- Existing native extensions and MCP servers are disabled for this initial adapter. Native harness global instructions/configuration are not presented as portable Randolph project configuration.
- Each run gets an independent RPC client and clean ephemeral native thread. Recorded speaker-labeled history is supplied to subsequent turns; opening a conversation never starts a turn. AI SDK UI transport remains an accepted future integration direction; this slice uses the application bridge directly.
- SQLite owns projects, conversations, run state, messages and ordered events. State changes and associated events are committed together. Per-run JSONL and human-readable activity logs are derived, rebuilt on reopen, and never competing state authorities.
- The default global root is `~/.randolph`. Per-run data lives at `projects/<project-id>/runs/<YYYYMMDD>_<run-id>/`, including a manifest and `logs/`. Local project content may appear in these private logs. Durable run data stays outside the repository; worktrees and explicit project configuration files live inside it.
- Git project conversations get detached worktrees under `.worktrees/randolph-<conversation-id>`. They begin from committed HEAD; copying dirty edits, parent selection and disabling worktrees are later UI work. Worktrees are retained. Non-Git or unborn repositories are read in place.
- Run model/effort is immutable after dispatch. Concurrent conversations have independent sessions; duplicate sends within a conversation are rejected, including while discovery is pending.

## Evidence and limitations

Offline runtime tests exercise concurrent conversations, admission during discovery, saved history without execution, failed storage, model snapshots, cancellation state and workspace identity/orphan handling. Native-adapter protocol tests cover ChatGPT authentication, model discovery, concurrent stream separation, failed/malformed responses and cancellation during startup. The desktop E2E launches actual Electron and drives project selection, sending, live activity, durable logs, renderer isolation, and reopening without another turn. Its CLI is scripted and consumes no inference.

Native discovery and one live desktop conversation were verified against installed Codex 0.149.0 with GPT-5.6 Luna at low effort, using the existing ChatGPT subscription. The agent read a synthetic README and correctly summarized the project in the chat. The retained database records exactly one native run and its completed response. Live evidence is outside the repository and separate from scripted tests.

The earlier lifecycle experiment demonstrated that a detached descendant can escape process-group cleanup. This slice requests native interruption and terminates/checks its owned process group; that is not a full descendant-containment guarantee. The application lacks an independent owner-loss watcher. These limitations remain release blockers and must not be described as solved by the desktop implementation. Safety sandboxing is v2 minimum and is not the lifecycle solution.

Other unfinished v1 work includes editing and exact final approval/commit/merge, separate explicit push, checkpoint restoration and restart UI, background/tray controls, Claude/Grok compatibility, delegation, workflow/catalog setup, configuration management, memory and context budgets. This is an incremental product delivery, not a reduction in approved v1 scope.
