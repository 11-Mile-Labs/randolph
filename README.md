# Randolph

A desktop workspace for coordinating AI agents around your projects.

Bring your existing AI subscriptions, choose the lead agent for each conversation, and keep work, decisions, and approvals visible across projects.

An independent project from [11 Mile Labs](https://github.com/11-Mile-Labs).

## Status

A developer desktop build now lives in `apps/desktop`, backed by `packages/runtime` and `packages/harness-codex`. It supports read-only project conversations through an installed, ChatGPT-authenticated Codex CLI. This is an initial product slice, not the complete v1 release.

## Run the desktop

Requires macOS, Node 24.16 or later (development pins 24.18), pnpm 11.8, and an installed Codex CLI signed into ChatGPT. The first dependency installation downloads Electron.

```sh
pnpm install
pnpm desktop
```

Choose **Add project**, select a local folder, choose a Codex model and effort, and send a message. The right panel shows native activity and the location of retained run logs. Multiple conversations can run independently. Reopening a conversation displays its history; it never sends a new turn automatically.

Git projects use a per-conversation worktree under `.worktrees/`, starting from committed HEAD. Uncommitted source edits are not copied in this slice. Non-Git folders are read in place. Durable state lives in `~/.randolph/app.sqlite`, with readable and JSONL run logs below `~/.randolph/projects/`. `RANDOLPH_DATA_DIR` selects a separate app-data directory for development/testing. Run logs can contain project content; they are private local data, not repository files.

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:desktop
```

The default tests use temporary fixtures and no model inference. The desktop test launches Electron with a scripted CLI and proves UI-to-runtime integration and history reopening. Live native execution is separate and uses the installed subscription.

## What works in this slice

- Projects, conversations, native model/effort discovery, streamed chat and conversation-scoped drafts.
- Visible activity, unread indicators, Stop requests, exact log locations, and history reopening.
- SQLite-backed run/message/event state, frozen run model/effort, derived JSONL/readable logs, and per-conversation worktrees.
- A narrow Electron preload/IPC boundary with an isolated renderer and locally bundled assets.

Write execution, final commit/merge, push, checkpoint restoration, Claude/Grok adapters, workflow/memory/configuration interfaces, background/tray support and AI SDK UI transport integration are not implemented in this slice. Process-group cleanup does not prove termination of detached descendants; hard owner-loss shutdown remains a release blocker. **Stop** requests native interruption and process-group termination, and reports uncertainty when that cleanup cannot be confirmed. There is no claim of application-level sandboxing; safety sandbox work is deferred until v2 at the earliest.

## What we are building

- **Projects with shared context.** Define purpose, important documents, instructions, skills, and workflows once, with configuration you can inspect and manage through the app.
- **Your choice of lead agent.** Select a harness, model, and effort level per project or conversation. Coordinate multiple conversations across multiple projects.
- **Execution that fits the task.** Let the lead agent handle simple work directly and propose additional agents when they provide a concrete benefit.
- **Visible work.** See current actions, delegation, waiting states, and approvals without opening raw logs. Expand the evidence when you need detail.
- **Reviewable outcomes.** Use isolated Git worktrees by default, inspect results, and explicitly approve final commit and merge. Pushing remains a separate action.
- **Useful history and learning.** Retain searchable run evidence, project and global lessons, and checkpoints for explicitly requested restarts.

## Integration direction

The initial target harnesses are Codex, Claude, and Grok through their installed CLIs and existing subscription authentication. Support is subject to capability verification for each harness version. Direct model API billing and automatic API fallback are outside the initial scope.

The design separates the desktop interface, local execution runtime, harness adapters, and durable storage. Agents make task decisions; application code controls execution and approvals. Protocol support alone does not establish reliable cancellation, approval enforcement, or recovery.

No application account or required cloud backend is planned. Harnesses and enabled integrations still communicate with their respective services.

## Open-source direction

The desktop application and execution runtime are intended for open-source release. License selection is pending. Personal service integrations and private operational data remain separate from the public core.

## Project documents

- [Product specification](docs/product-spec.md): approved behavior, the 14 initial workflows, v1 scope, and deferred features.
- [Architecture](docs/architecture.md): accepted responsibilities, proposed technology, and unresolved control boundaries.
- [User journey](docs/user-journey.md): project setup through an approved bugfix and recovery.
- [Roadmap](docs/roadmap.md): proposed milestones and their completion evidence.
- [First controlled-run experiment](docs/plans/first-controlled-run.md): bounded plan before building the full application.
- [Experiment getting started](experiments/controlled-run/README.md): offline checks and explicit native execution prerequisites.
- [Deterministic Git proof](docs/research/scripted-git-2026-09-12.md): passed real native execution, sandbox denial, declined approval and permitted positive control, without model inference.
- [Completed lifecycle experiment](docs/research/lifecycle-completion-2026-09-12.md): Stop and controller/harness-crash cleanup passed; a detached-child escape failed containment and remains a release blocker.
- [Checkpoint and restart proof](docs/research/checkpoint-restart-2026-09-12.md): restored after source-repository deletion and verified in a fresh subscription-backed native session.
- [Desktop implementation boundary](docs/decisions/desktop-first-slice.md): selected package structure, storage/IPC decisions, verified behavior and remaining work.
- [Permission follow-up](docs/research/permission-followup-2026-09-12.md): verified workspace semantics and a real declined approval; standalone Git remains unverified.
- [Controlled-run results](docs/research/controlled-run-2026-09-12.md): observed subscription execution, denied diagnostic mutations, and incomplete protection proof.
- [Initial harness findings](docs/research/harness-compatibility.md): observed subscription integration and remaining limitations.

The specification records the complete intended product. The implemented subset and its remaining limits are described above; research results are evidence for individual mechanisms, not release claims.
