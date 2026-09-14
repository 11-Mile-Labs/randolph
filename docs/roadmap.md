# Randolph v1 roadmap

Status: proposed implementation sequence for the [approved product scope](product-spec.md). Milestones are outcome boundaries, not promised dates or authorization to execute every stage. The current implementation extends the [first desktop product slice](decisions/desktop-first-slice.md) with [controlled coding and delivery](decisions/controlled-coding.md): native Codex conversations and worktree editing, visible checks, explicit local delivery, and durable history in normal app/runtime packages. M1 is not fully passed; its detached-process lifecycle failure remains open.

The [project harness defaults follow-up](decisions/project-harness-defaults.md) adds editable model/effort defaults, saved conversation overrides, and immutable run settings. The [working application plan](plans/working-application.md) tracks ongoing implementation across milestones. These slices cover parts of M2/M3; full configuration management and additional harnesses remain unfinished.

## Current implementation order

1. Complete the delegation coordinator: connect proposals and presets to the full authorized task graph, shared main/worker admission, visible queues and controls, immutable sources, explicit Code integration/check phases, and main synthesis. The graph driver now has complete scripted Code-path and Pause/Resume proofs; a native Codex Code graph also completed writing, integration, content checks, review, and synthesis with confirmed cleanup. Ordinary discovery, main/setup turns, and review checks now share durable app-wide admission and restart quarantine. Delegated discovery, model turns, and project checks now use that same service with separate admissions, charged source validation, and final source rechecks. A durable workspace ownership service and coordinator proofs preserve planned writers, terminal evidence, and runtime-only quarantine. Ordinary runs and linked recovery, setup, checkpoint export, checks, delivery, integration, and push now use the same durable workspace authority. Original unfinished writers are retained on reopen, including missing paths. Run activity now reads queued/native operations and retained cleanup directly without discovery, including workspace-only and legacy cleanup. Separate decision revisions preserve queued work during priority and budget changes. Visible control commands, preset selection, repair generations, explicit recovery for the remaining uncertain operation types, and production scheduler enablement remain pending.
2. Complete native harness coverage. Grok writing and project checks must use a verified Grok-only boundary; authentication alone does not establish it. Complete Claude support and cross-harness acceptance using existing subscriptions. Native compatibility work can proceed alongside coordinator work, while unavailable routes remain disabled.
3. Complete all fourteen workflows, guided setup, local and Linear backlogs, outcome-driven advancement, and the attention inbox.
4. Complete context/skill/hook selection and inspection, shared configuration, worktree/branch choices, optional external memory contracts, history, import/export, retention, and the remaining recovery paths.
5. Finish macOS release acceptance: close owner-loss and detached-process failures, test accessibility and fresh installation/upgrades, and complete license, signing/notarization, packaging, and update delivery. Lifecycle defects remain active work throughout implementation, not postponed investigation.

The coverage map below remains the complete v1 scope. This order groups implementation dependencies; it does not reduce the product to the currently verified slices.

## Milestones

| Milestone                       | Deliverable                                                                                                                       | Exit evidence                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Product foundation         | Product specification, architecture, journey, compatibility summary, and first experiment plan                                    | Linked, reviewed documents that distinguish approved behavior, proposals, and unknowns                                                                   |
| M1 — One controlled run         | Headless synthetic project with one native main agent, visible events, protected delivery, stop, checkpoint, and explicit restart | Reproducible native approval and lifecycle tests; restoration after deleting the source worktree; complete pass/fail report                              |
| M2 — Desktop workspace          | Project/conversation navigation, chat, model/effort controls, live activity, context selectors, review, and background controls   | End-to-end UI drives the verified runtime; stale activity and pending approvals remain visible; desktop-host crash tests pass                            |
| M3 — Cross-harness coordination | Codex, Claude, and Grok adapters; discovery/setup; scoped shared context; editable delegation plans/presets; concurrency          | Same control contract verified for each supported route; cross-harness work observable; no unapproved native workers or API fallback                     |
| M4 — Complete project workflows | Workflow engine/catalog, guided creation, local+Linear backlog, built-in memory, configuration UI, attention and history          | Approved workflow outcomes and status mappings work; repeatable setup preserves customization; memory/context provenance and project boundaries verified |
| M5 — macOS release              | Installation/package, recovery hardening, accessibility, documentation, license, and OSS release preparation                      | Full v1 acceptance matrix passes; fresh-machine installation and upgrade/recovery exercised; public artifacts checked                                    |

M1 narrows the experiment, not the product. Passing one adapter does not reduce v1's three-harness target. M2 implementation now proceeds as bounded usable product slices while remaining control gaps stay explicit. This does not waive M1 requirements or imply unverified execution guarantees.

## M0 checklist

- [x] Preserve approved product behavior and deferred scope.
- [x] Record accepted architecture boundaries separately from proposed technology.
- [x] Keep the user journey alongside the specification.
- [x] Publish a sanitized account of initial compatibility evidence and its limits.
- [x] Complete the bounded first-experiment plan and documentation review.

## M1: smallest useful proof

One synthetic repository, one conversation, one main agent, and one worktree inside that repository. A headless view emits readable activity and structured events. Durable evidence and checkpoints live outside the source repository; scratch is volatile.

Codex App Server is the first route because the initial probe already exposed model discovery, streamed activity, and concrete permission/lifecycle questions to isolate. This is a proposal for experiment order, not a preferred or mandatory default main agent for users.

Permission and lifecycle experiments have produced bounded passes and an explicit detached-process failure. Continue product implementation in apps and packages; retain the failure as a release blocker instead of extending the experiment indefinitely. Do not silently replace hard controls with prompt instructions, bring micro-VMs into v1, or fall back to API billing.

## V1 coverage map

| Approved behavior                                                                                                    | Primary milestone |
| -------------------------------------------------------------------------------------------------------------------- | ----------------- |
| First-class projects, multiple conversations and projects concurrently, one active run per conversation              | M2, M3            |
| Main harness/model/effort defaults and overrides; Fast/Balanced/Thorough preferences                                 | M2, M3            |
| Automatic CLI discovery, reviewed AI-assisted setup, safe repeat setup, no config migration                          | M3, M4            |
| Shared agents, hooks, skills, instructions; portable capability reporting                                            | M3                |
| Preset authorization banners; combined editable proposals; explicit save; version-specific approval; YOLO limits     | M1, M2, M3        |
| Obvious activity, unread indicators, project/shared inbox, notifications                                             | M2, M4            |
| Stop/Pause/Resume; background setting; menu-bar controls; explicit restart only                                      | M1, M2, M3        |
| Worktree defaults, parent selection, dirty-change copy choice, shared-checkout writer coordination                   | M1, M2, M3        |
| Final reviewed commit/merge, separate push, stale-parent invalidation, cleanup/reconciliation                        | M1, M2, M5        |
| Context references with @, skills with / and +; previews/external editor; pinning and budget indicators              | M2, M3, M4        |
| Concise context preparation, provenance, relevant retrieval, no silent loss of pinned requirements                   | M3, M4            |
| All 14 workflows, flexible/prescribed steps, guided creation/refusal, repair/retry/time limits                       | M4                |
| Share/export/import independent workflow and preset copies; explicit updates                                         | M4                |
| Local and Linear backlog, list/board, linked conversations, outcome-driven advancement                               | M4                |
| Local project/global lessons, separate approval settings, external retrieval and optional write-back                 | M4                |
| Focused dot-separated YAML, UI management, external edit validation, run snapshots                                   | M3, M4            |
| Global durable run files; JSONL/readable logs; volatile scratch cleanup; opt-in retention                            | M1, M4, M5        |
| Checkpoint restoration, historical viewing without execution, explicit restart/rerun, external-effect reconciliation | M1, M4, M5        |
| macOS distribution, no app account/cloud requirement, public-safe core                                               | M5                |

## Decisions needed at the point of use

| Decision                                                                            | Resolve before                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Actual native-tool authorization boundary and owner-loss mechanism                  | M1 can claim a pass                             |
| Electron/React/TypeScript versions and packaging, private IPC shape                 | M2 implementation                               |
| Config directory, global data root, event/schema versions, transactional authority  | Durable runtime promotion beyond the experiment |
| Adapter capability contracts and influence of existing native configuration         | M3 writing/delegation support                   |
| Workflow contracts/default limits, board/status mappings, write-back reconciliation | Respective M4 feature implementation            |
| License, signing/notarization, update delivery, published privacy behavior          | Public distribution                             |

Decisions should record the problem, considered alternatives, chosen behavior, evidence, and consequences in [architecture](architecture.md) or a focused linked decision document. Do not reopen approved user behavior to avoid an implementation difficulty.

## Deferred beyond v1

Safety sandbox/micro-VM work is deferred until v2 minimum, solely for safety isolation. Guided follow-up suggestions across conversations, multiple repositories per project, direct API billing, other desktop platforms and trackers, team collaboration, and broader marketing/business automation remain deferred as specified in the product document. No plugin marketplace is included in this roadmap.

## Release interpretation

An experiment pass establishes a tested boundary on named versions and fixtures. A release requires the complete v1 behavior, cross-harness coverage, and real desktop lifecycle tests. Any proposed scope reduction must be explicit and approved; partially working adapters cannot be relabeled as full support.
