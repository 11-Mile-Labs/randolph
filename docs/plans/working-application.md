# Working application implementation plan

Status: active implementation toward the complete [approved v1 scope](../product-spec.md). This plan tracks usable product increments; completing an increment does not complete v1 or waive its remaining requirements.

**Goal:** deliver a working macOS project workspace with controlled coding, retained history/recovery, subscription-backed harness coordination, workflows, context, memory, backlog, and distribution.

**Architecture:** the desktop submits typed commands to the local runtime. The runtime owns state, process control, approval, verification, Git delivery, and recovery. Adapters translate installed subscription-backed harness protocols; they do not grant themselves delivery authority.

**Tech stack:** existing Electron/React/TypeScript packages, SQLite, editable project YAML, installed Git and native harness CLIs. Reuse established dependencies and keep production code independent of experiments.

## Constraints

- Preserve the product specification's complete v1 scope and approval semantics.
- No model API fallback or required private service integrations.
- Worktrees stay inside repositories; retained evidence stays outside them.
- Final approval is manual. Push/publish/send are separately explicit actions.
- No automatic execution on reopen or automatic restart of interrupted runs.
- Safety sandbox/micro-VM work is v2 minimum. Native permission controls still enforce supported execution boundaries.
- Existing detached-descendant and owner-loss failures remain open until verified fixes pass their original requirements.

## 1. Controlled coding and delivery

- [x] Add an explicit Code mode alongside read-only conversations, with native capability checks and immutable run mode.
- [x] Allow ordinary worktree edits and checks through the verified Codex workspace-write policy; deny native elevation and protected Git operations.
- [x] Retain useful command/file-change evidence without presenting command output as assistant text.
- [x] Capture complete review trees and diffs, including eligible untracked/binary files and modes, without changing the real Git index or refs.
- [x] Present verification, changed files, combined diff, and target parent before final approval.
- [x] Bind final approval to the exact worktree tree, parent revision, and successful checks; invalidate stale requests.
- [x] Record delivery intent before mutation, then reconcile commit, merge, and cleanup outcomes independently after interruption.
- [x] Support parent integration/conflicts and fresh verification/approval; push remains a separate explicit action.
- [x] Verify with real synthetic repositories, fake native protocol tests, actual Electron UI, and bounded native compatibility evidence where needed.
- [ ] Prepare conversation worktree dependencies before Code dispatch and checks: runtime-detected pnpm install with an offline preference, outside the native sandbox, sanitized environment, time limit, bounded output, and a durable receipt; failure blocks dispatch and checks visibly. Approved for v1 on 2026-09-15.

**Files:** extend `packages/harness-codex/src/index.ts`, runtime contracts/store/orchestration, Electron bridge/validation and renderer. Add focused Git review/delivery and verification modules with behavioral tests. Keep native fault fixtures outside real projects.

## 2. Recovery and application lifetime

- [x] Promote self-contained Git checkpoints into the runtime and expose history/file restoration controls.
- [x] Implement linked model Restart/rerun with retained configuration/context and fresh approvals while the related original Git repository remains available.
- [x] Verify file restoration after original source/worktree loss while preserving original history.
- [ ] Complete original-repository-loss execution recovery, later workflow/external-effect reconciliation, and non-Git recovery.
- [x] Implement application navigation/settings, background execution, menu-bar controls, opt-in notifications, and explicit quit behavior.
- [x] Share durable workspace ownership across ordinary runs/recovery, setup, checkpoint exports, verification, integration, delivery, and push; retain unfinished original writers without execution on reopen.
- [ ] Complete explicit recovery controls for uncertain workspace operations beyond project setup.
- [ ] Implement Pause/Resume.
- [ ] Complete descendant and owner-loss control without a VM; rerun fault cases and retain honest compatibility limits.

## 3. Harnesses and project context

- [x] Integrate AI SDK UI through an application-owned IPC chat transport with retained-event replay and no API execution path.

- [x] Discover installed Codex copies, expose path/version, persist per-project CLI selection, and retain run/check/recovery executable identity.

- [x] Add shared harness routing with frozen run/check/recovery identity and legacy Codex compatibility.
- [x] Add Grok native subscription discovery and visible capability gating; execution remains disabled after the [failed native filesystem boundary probe](../research/grok-adapter-2026-09-12.md).
- [ ] Complete native Claude and Grok subscription execution adapters with passing capability/authentication evidence.
- [x] Add explicit Codex project inspection, editable proposals, approval receipts, and revision-pinned project context; see [project setup](project-setup.md) for recovery limits.
- [ ] Implement discovery/setup, project harness enablement, shared context/instructions/skills/hooks, file/skill selectors and previews.
- [ ] Add context preparation, pinned material, provenance, budget indicators, and safe transcript management.
- [ ] Implement editable delegation proposals, saved presets, version-specific approval, concurrency and visible worker activity.

## 4. Workflows, memory, and backlog

- [ ] Implement guided workflow creation and the approved 14-workflow catalog with limits, retries, and outcomes.
- [x] Add built-in scoped memory/lesson review, version history, exact pins, and retained context provenance.
- [ ] Add optional memory integration contracts and broader context preparation.
- [ ] Add local and Linear backlog views, linked conversations, outcome-driven advancement, and reconciliation.
- [ ] Complete project/shared attention views, settings management, import/export, and retention controls.

## 5. Distribution and acceptance

- [ ] Complete the v1 acceptance matrix against the product specification.
- [ ] Verify fresh-machine installation, recovery/upgrade, accessibility, and public-safe artifacts.
- [x] Package a local macOS application with Randolph identity, native menus, and supplied artwork.
- [ ] Complete DMG distribution, license, public signing/notarization, and update delivery.
- [ ] Obtain explicit authorization for repository merge/push and any external release actions.

## Verification discipline

For each implementation increment: write meaningful failing regression/acceptance tests, implement, inspect real UI where applicable, run lint/typecheck/build/tests, obtain independent review, and commit the bounded result locally. Tests must exercise application behavior or real synthetic effects; fake adapters alone do not certify native permissions, subscription compatibility, or lifecycle control.
