# Randolph: project-centered agent desktop application

Status: approved product behavior, consolidated for implementation planning. Technical proposals and unresolved details are labeled separately. This document specifies intended behavior; it does not claim implemented features or an approved release date.

Randolph is a new product designed around the requirements below. The entire desktop application and execution engine are intended for open-source release. Personal integrations must remain separate from the public core.

## Purpose

Provide a local desktop workspace where a user can define a project, converse with a selected lead agent, coordinate work across subscription-backed AI harnesses, and understand what happened. Scale execution to the actual task, preserving explicit approvals and reviewable evidence without imposing lengthy process on simple work.

The product should be useful to other developers out of the box and demonstrate strong architecture and engineering. Broader business AIOS ambitions are a distant possibility, not a v1 requirement.

The primary v1 audience is individual developers managing multiple projects and AI subscriptions. Team collaboration is deferred.

## Platform and delivery

- macOS only for v1. A DMG is preferred; manual installation is acceptable for early builds.
- No account for this application and no required cloud backend.
- Configuration, conversations, lessons, and retained run material are local. Harnesses and enabled integrations connect to their own services.
- The whole application and execution engine are open source under the [MIT License](../LICENSE). Distribution details remain open.

## Projects and conversations

- Projects are first-class objects. Users can add, open, and switch projects.
- A project owns its purpose, repository, document references, instructions, agents, skills, hooks, workflows, harness preferences, conversations, runs, and project lessons.
- V1 supports one repository per project. Multi-repository projects are deferred.
- Setup supports an existing repository or a new project starting from an idea.
- Setup inspects available evidence first, presents its inferred understanding for approval, and asks follow-up questions to resolve gaps or corrections.
- First-time setup discovers installed harnesses and shows readiness before AI-assisted inspection. The user selects a ready setup harness, model, and effort; that agent inspects the project and presents its understanding for approval. Offer to retain this agent configuration as the project default. If no harness is ready, show setup guidance; never silently fall back to an API.
- Setup can be rerun safely, preserving customization and showing proposed changes.
- Importing or migrating existing harness instructions, skills, hooks, or configuration into app management is out of scope. If undertaken later, it will be a separate one-off process owned outside this application. This does not remove setup's repository inspection or automatic discovery of installed harness CLIs.
- Chat with the main agent is the center of a project. The interface should feel familiar to Codex and Claude users while having its own product identity.
- V1 provides code/document previews and diffs, with an Open in editor action for an external editor. Direct code/document editing inside the app is out of scope; dedicated configuration-management UI remains in scope.
- Approved main workspace layout: projects and conversations on the left; main-agent chat, composer, delegation banner, and visible activity in the center; an expandable right panel for document previews, diffs, and run details. Project navigation includes backlog, workflows, presets, memory, and settings. Shared attention and global settings are accessible above the project level.
- The approved visual direction uses the layout described above. Detailed visual design and accessibility behavior still require implementation specifications.
- Each project defines a default main-agent harness, model, and effort. Each conversation can override them.
- Multiple conversations may run concurrently within one project and across projects.
- Each conversation has at most one active run and retains previous runs in its history. Resume continues a paused run. Restart after a stop or interruption creates a new linked run in the same conversation from a retained checkpoint. Deliberately rerunning an earlier result creates a new linked conversation and run. A backlog item can link to multiple conversations over its lifetime.
- A new conversation can reference durable documents from earlier work. Guided follow-up suggestions and context handoffs are deferred to v1.5/v2.

## Harnesses and shared project context

- V1 harnesses: Codex/ChatGPT, Claude, and Grok, using subscriptions. Direct API connections and API billing are out of scope for v1; no automatic API fallback.
- The app automatically discovers installed harness CLIs and distinguishes ready, setup-needed, and unavailable states.
- Discovery is app-wide. Enabling a harness and CLI for execution is project-specific.
- A main agent may delegate across enabled harnesses, irrespective of its own harness.
- Projects provide common agents, skills, hooks, and instructions. Exact portability and adaptation rules remain to be designed.
- Architecture direction accepted: AI SDK UI, an application-owned execution service, and harness adapters; use ACP where suitable and native interfaces where required.
- High-level component boundaries approved: desktop UI for interaction and review; local execution runtime for authorization, workflow, scheduling, worktrees, checkpoints, and delivery; harness adapters for protocol/capability translation; durable storage for configuration, history, context, artifacts, and recovery. The selected main agent coordinates task judgment and requests delegation; application code validates and controls execution. Native-tool approval enforcement and descendant shutdown after application failure still require compatibility proofs.
- Harness adapters use ACP where suitable and native interfaces where required. ACP, when used, connects the app to an agent. Cross-agent coordination remains controlled and recorded by the application, with application tools potentially exposed through MCP.
- Claude integration proceeds under the user's accepted working assumption that running the user's unmodified CLI with Anthropic-owned authentication fits the intended use. This is not verified vendor approval. Keep the adapter replaceable and the research boundary explicit.

Technical evidence: [bounded native harness experiment](research/harness-compatibility.md). The experiment establishes partial compatibility, not production support. [Architecture](architecture.md) identifies the proposed integration boundaries and primary references.

## Delegation and approvals

- Automatic planning defaults to the selected main agent working alone. Propose additional agents only for a concrete benefit, such as independent review, specialized expertise, or useful parallel work, and explain that benefit. Explicitly selected workflows or presets can require particular roles. Task simplicity must not trigger unnecessary orchestration overhead.
- Automatic delegation has a project-level routing preference, overridable per conversation: Fast favors quick execution and lower effort for bounded work; Balanced matches model capability and effort to complexity and risk; Thorough favors deeper analysis and stronger verification. Balanced is the out-of-the-box default. Preferences guide proposed assignments without bypassing required checks or approvals, and do not automatically replace the user's selected main agent.
- Projects can define a default delegation preset. A conversation can select it, select another, create one, or ask the main agent to propose assignments.
- Selecting an existing preset authorizes delegation immediately. A compact conversation banner shows the preset and agent assignments, harnesses, models, and effort levels, with expandable detail.
- A newly proposed delegation plan requires approval before execution. At approval, offer to save it as a named project preset; saving and approving execution are separate choices.
- Present proposed delegation in an in-conversation approval card showing each agent's task, harness, model, effort, assignment rationale, dependencies and parallel work, execution limits, and expected deliverables. Users can edit assignments directly on the card or request revisions conversationally. Explicit approval applies to the revised plan displayed on the card; saving it as a project preset remains a separate choice.
- When both a workflow and agent assignments are proposed at startup, combine them into one editable approval card showing the workflow, assignments, execution limits, and expected outcomes. One approval authorizes the complete displayed plan. Saving the workflow or delegation preset remains a separate choice; later changes follow the selected approval mode and version-specific approval rules.
- Changes to an authorized delegation plan are exceptional. Explain the change and its reason and obtain approval before affected work proceeds.
- Approval applies to the exact version presented for review across chat, inbox, and final review. A revision to a pending plan, assignment, or deliverable invalidates its previous approval request. The replacement highlights changes and requires a fresh decision under the applicable approval mode; stale cards and notifications cannot authorize the revised version.
- YOLO mode automatically approves intermediate decisions while keeping them visible and logged.
- YOLO never bypasses final approval or exhausted execution limits.

## Workflows

- Users can explicitly select a workflow and supply initial context, or start a conversation and approve a workflow when the main agent proposes one.
- Workflow selection authorizes the process; it does not automatically authorize final delivery actions.
- A workflow defines context, intended outcomes, constraints, and completion checks. It may also prescribe steps and their outcomes, leaving other steps for the agent to determine.
- Changing a prescribed step requires approval, subject to the conversation's intermediate-approval mode.
- If no workflow fits, the agent may ask whether the user wants to create one. A refusal must be honored without repeated prompting or preventing conversational work.
- Guided creation takes place through a conversation and produces an editable draft for approval before saving.
- Workflows and delegation presets are shareable between projects and exportable/importable. V1 imports independent, project-editable copies that retain source and version provenance. Later updates present a comparison and require explicit application; edits never propagate automatically between projects, and active runs retain their starting versions. The export format remains unresolved.
- Workflows specify code-repair attempt limits and separate infrastructure retry limits. Exhaustion requires approval to continue, even in YOLO mode.
- Workflows have configurable active-execution time budgets. Queue time, approval waits, and paused time are excluded.
- On time-budget exhaustion, prevent new dispatches, request a pause at the next safe boundary, and ask for an extension. Show Pausing until active work settles.

### Approved initial catalog: 14 workflows

| Category             | Workflow                      |
| -------------------- | ----------------------------- |
| Product Manager      | Product Planning              |
| Product Manager      | Backlog Grooming              |
| Product Manager      | Discovery & Validation        |
| Product Manager      | Feature Prioritization        |
| Product Manager      | Release Planning              |
| Software Engineering | Architecture & Infrastructure |
| Software Engineering | Development                   |
| Software Engineering | Bug Triage                    |
| Software Engineering | Bugfix                        |
| Software Engineering | Code Review                   |
| Software Engineering | Codebase Assessment           |
| Business Operations  | Process Design & SOPs         |
| Business Operations  | Research & Decision Brief     |
| Business Operations  | Operational Review            |

Each workflow still needs its own inputs, completion criteria, default limits, and behavior specification. The catalog does not authorize branding, marketing, or deeper business-operations workflows for v1.

## Visible activity, attention, and control

- Ongoing activity must be obvious in the conversation without opening logs or an inbox.
- Compact agent activity shows who is working, what action is underway, execution state, elapsed time, and update freshness. Detailed action history and logs are expandable.
- Distinguish confirmed activity from a lack of recent reports. A spinner alone is insufficient evidence of progress.
- Conversation lists show unread activity, pending approvals, and run status. Project entries surface attention even when collapsed.
- Viewing an approval request does not resolve it.
- Provide project-level attention inboxes and a shared inbox ordered newest to oldest. Entries link to the originating conversation. Intermediate decisions can be approved directly in the inbox, with the proposal, scope, and consequences inspectable in place. Final approval opens the conversation's review view to inspect deliverables, verification, and the combined diff before committing and merging where applicable.
- Support configurable macOS notifications for approval requests, failures, and completed runs when the user is outside the app. These supplement the in-app unread, activity, and attention indicators.
- Provide Stop, Pause, and Resume at conversation and project levels, plus Stop all, Pause all, and Resume all in the background menu bar.
- Pause prevents new dispatches immediately and allows active operations to reach a safe stopping point. Show Pausing until settled.
- Resume applies only to paused work. Stopped or interrupted runs require an explicit restart from the last completed checkpoint.
- Stop must include delegated work, prevent new dispatches, and accurately indicate whether processes exited.
- A crash or intentional app termination loses unfinished execution. Preserve history and evidence, but never automatically restart work when the app reopens.
- Background execution is optional. When disabled, closing with active work warns that work will terminate and offers Cancel, Terminate work and close, or Change settings.
- When background execution is enabled, closing the window leaves work running with a menu-bar activity/attention indicator. Explicit quitting still warns about active work.
- Configure concurrency limits app-wide and per harness. Show queued work and its reason for waiting. Users can prioritize the next available slot; reprioritizing does not interrupt active work.

## Context selection and preparation

- `@` in the composer searches workspace files and folders.
- `/` opens a searchable skill picker with names and descriptions.
- The `+` menu provides GUI access to file/folder selection and skill selection.
- Selected references and skills appear as removable chips before sending.
- Workspaces may include selected reference files/folders without treating them as additional managed repositories.
- Prepare concise prompts: remove filler and repetition, deduplicate context, and select relevant history and lessons while preserving substance.
- Preserve requirements, prohibitions, approval boundaries, acceptance criteria, uncertainties, and precision-sensitive identifiers and evidence.
- Users can pin lessons and documents into project context. Do not silently drop pinned material when budgets are exceeded.
- Retain the source material and prepared context with their relationship, so users can inspect what was supplied to agents.
- Provide context indicators showing included and summarized material and estimated token size.
- Model context limits and supported effort settings inform preparation and dispatch. Reserve room for outputs and tool results; do not equate the advertised window with usable input budget.
- Distinguish measured values, estimates, and unavailable values. Harness-controlled overhead and compaction may limit what the app can observe.
- Subscription consumption is not equivalent to API dollar cost. API monetary budgeting is deferred with API support.

## Learning and retrieval

- Lessons can be project-scoped or global. Apply global lessons selectively to relevant projects, including framework/version applicability where appropriate.
- Project lessons default to approval before use. Users can enable automatic approval and immediate use per project.
- Global lesson approval has a separate app-wide setting.
- Manual approval should support grouped review without interrupting active work.
- Lessons remain visible, editable, reversible, and connected to supporting evidence. Represent superseded knowledge explicitly.
- Use a consistent retrieval interface across scopes and storage integrations to build prompts/context.
- Record which lesson versions were supplied to each agent.
- Useful built-in local memory is required. External knowledge systems, such as personal knowledge services, are optional integrations.
- An enabled external knowledge service works alongside the built-in memory store as an optional additional knowledge source, rather than replacing it. Both use the consistent retrieval interface.
- Newly learned lessons are stored in built-in memory by default. Each integration has an optional setting allowing approved lessons to be written back to that system as well.
- Write-back delivery, synchronization, deduplication, and conflict handling between built-in memory and external systems remain unresolved.

## Backlog and Linear

- V1 includes a local backlog and Linear integration. A project can display both together.
- One linked Linear project per app project initially.
- Local items are authoritative locally; Linear items remain authoritative in Linear.
- Support creating and updating Linear descriptions, status, and comments, with visible actions and approval-mode behavior.
- Provide list and board views over the same items, source labels/filters, details, linked conversations, and a Start work action supplying item context to a new conversation.
- Successful workflow outcomes advance the issue to the next configured status. Ending a conversation alone is not success.
- Per-project/workflow mappings target local or Linear statuses. Illustrative transitions are planning approval to development-ready, implementation completion to review, and approved successful merge to done; these are not mandatory universal status names.
- Failed or stopped work does not advance the issue. Failed external updates remain visibly pending for reconciliation.
- Local status customization and the precise mapping into shared board columns require detailed design.

## Configuration, worktrees, and retained material

- Readable, version-controlled project files are the source of truth, managed by the UI and editable directly.
- Use descriptive dot-separated filenames such as `config.harness.yaml` and `config.log-settings.yaml`.
- Validate edits, detect external modifications, and avoid overwriting them. Setup/import changes should be reviewable.
- A run snapshots its starting configuration. Subsequent configuration edits affect new runs only. Explicitly approved changes during a run require recorded provenance.
- Worktree isolation is the default, with a visible per-conversation opt-out.
- Before starting, show the repository's currently checked-out branch as the default parent and allow the user to select another branch. Existing uncommitted changes remain in the original checkout by default; including a copy in the new worktree requires explicit selection and does not move or remove the original changes.
- When worktree isolation is disabled, allow only one active app-managed writer per shared checkout across the application. Other conversations may continue reading, researching, and planning; editing waits in a visible queue identifying the conversation holding write access. Separate worktrees continue independently. This coordinates app-managed agents only; external edits must still be detected and handled.
- Worktrees live inside the repository. A single writing agent uses the conversation's worktree; other agents can read and investigate alongside it. When parallel writing is worthwhile, each writer gets a separate worktree inside the repository. The coordinator integrates their changes into the conversation's worktree and verifies the combined result before presenting it for final approval. Worktree opt-out behavior still needs detailed design.
- Before a Code-mode run's first native dispatch and before project checks, the runtime prepares the conversation worktree's dependencies itself. Preparation uses a bounded, runtime-detected package-manager command for the detected toolchain (initially `pnpm install --frozen-lockfile` with an offline preference for pnpm projects that declare a lockfile), runs outside the native sandbox with a sanitized environment, a time limit, bounded retained output, and a durable receipt tied to the worktree identity and lockfile digest. Project configuration cannot supply arbitrary preparation commands. Failed preparation blocks Code dispatch and checks visibly; preparation never runs on reopen or for read-only conversations. Approved for v1 on 2026-09-15.
- Retained conversation material lives in a global app folder, organized by project and run: logs, artifacts, configuration snapshots, and review evidence.
- Durable run history is retained until the user deletes it by default. Automatic retention limits are opt-in. Before deletion, show whether removing the selected material would prevent historical review or rerunning a checkpoint. Temporary scratch files remain eligible for automatic cleanup once no longer in use.
- OS temporary storage is volatile scratch space. Protect items while in active use, release afterward, and clean regularly. No history, approval, or checkpoint recovery may depend on released temporary files.
- Machine-searchable and human-readable logs are required. Exact event schemas and folder naming remain open.

## Run history and replay

- A checkpoint preserves the code and retained artifacts at that point; completed and pending work; relevant decisions; configuration and context needed to restart; and a record of completed external actions so recovery can avoid duplicating them. The application creates checkpoints automatically at meaningful completed steps without another approval or an extra agent. A checkpoint is labeled recoverable only after the necessary material is durably saved.
- V1 supports reviewing a recorded run without executing anything. The timeline exposes assignments, supplied context, tool activity, approvals, changes, and results.
- V1 also supports an explicitly requested rerun from a retained checkpoint, creating a new run linked to the original and using saved configuration and context. Preserve the original run and request required approvals again.
- Restarting stopped or interrupted work keeps the conversation and creates a new linked run in its history. Deliberately rerunning an earlier result opens a new linked conversation. Neither operation happens automatically; Resume continues the existing paused run.
- Reruns may produce different AI output. Recorded history remains the account of the original execution; rerunning does not promise deterministic reproduction.

## Final approval and cleanup

- Delivery recovery tracks and displays the confirmed outcome of each step: commit, merge, cleanup, and linked-issue update where applicable. After an interruption, reopening checks what completed and waits for the user to explicitly continue unfinished steps. Recovery must not repeat completed actions or automatically restart agents. Continuing in a way that changes the approved result or target branch requires fresh verification and approval. Technical reconciliation must account for actions whose outcome was not durably recorded before interruption.
- Present results, verification evidence, and a browsable diff before final approval.
- Final approval commits all non-ignored changes in the conversation worktree and merges to its parent branch.
- Push to origin is a separate explicit action, including in YOLO mode.
- After successful merge, remove the temporary worktree and branch. Preserve conversation history, logs, and review evidence.
- For non-code workflows, final approval accepts the deliverables and advances the issue to the configured next status. Externally publishing or sending those deliverables is a separate explicit action, including in YOLO mode.
- If merging reveals conflicts, the agent resolves them, reruns relevant checks, and presents the revised result for fresh final approval. The earlier approval does not authorize merging the revised result; YOLO cannot bypass the fresh final approval.
- When worktree isolation is disabled, final approval commits only the conversation's changes on the current branch, with no merge step. Pre-existing unrelated changes remain untouched. Change attribution and overlapping-edit handling require detailed design.
- Before presenting final approval, update the conversation's worktree against the latest parent branch, resolve any conflicts, and verify the combined result. If the parent branch changes while approval is pending, invalidate that request, update and verify again, and present a fresh approval request. This applies even to conflict-free updates because integration can change behavior. Failed verification still requires detailed design.

## Deferred scope

- Safety sandbox execution, preferably with a worktree inside the sandbox: v2 minimum. Micro-VM technology is not selected and is not an execution or lifecycle requirement.
- Guided follow-up work suggestions and cross-conversation creation/context handoff: v1.5/v2.
- Multi-repository projects, API connections/billing, additional desktop platforms, and additional issue trackers.
- Team collaboration.
- Branding, marketing, deeper business operations, and a business AIOS.

## Personal integrations: proposed direction, not yet approved

Provide public extension contracts and useful built-in implementations. Keep private service addresses, credentials, schemas, and customer-specific behavior in separately installed adapters. An external knowledge service must not be a prerequisite for the core application.

Candidates for extension boundaries include knowledge retrieval/storage, issue trackers, harness adapters, and workflow/skill packs. A general plugin marketplace, executable plugin permissions, compatibility/versioning, installation, and updates are not yet approved scope.

Approved: optional external knowledge services augment built-in memory through the common retrieval interface. Newly learned lessons default to built-in storage; each integration can optionally receive approved lessons through its write-back setting. Delivery behavior and handling of overlapping or conflicting records remain open.

## Remaining design work

1. Personal integration boundaries and memory authority.
2. Precise workflow contracts, default limits, and checkpoint semantics.
3. Git ownership, merge conflict handling, parent branch changes, and worktree opt-out behavior.
4. Approval scope, pending-action invalidation, YOLO behavior, and stop guarantees across harnesses.
5. Configuration/event schemas, global path conventions, retention, export/import, and setup reconciliation.
6. Backlog status mapping, external-update reconciliation, and tracker approval scope.
7. Harness capability proofs, subscription-authentication checks, context accounting, and Claude product conditions.
8. Visual design, screen hierarchy, accessibility, and interaction prototypes.
9. Public repository structure, license, packaging, signing, and release process.

These are unresolved design topics, not blockers requiring immediate user answers. They should be resolved in manageable groups before implementation.

Architecture discussion: [component boundaries and proposed execution design](architecture.md). The high-level boundaries are approved. Detailed technical choices remain proposed and compatibility conditions remain unverified; this is not an approved implementation plan.
