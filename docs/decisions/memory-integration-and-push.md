# Memory, parent integration, and separate push

Status: implemented developer capability. See the [working application plan](../plans/working-application.md) for remaining v1 work.

## Scoped lessons

The Memory dialog creates and edits project or global lessons, reviews multiple lessons together, pins exact versions to a project, and displays/restores version history. Edits create a new version and invalidate the previous approval. Pins retain their exact version; an obsolete pin blocks a new run until explicitly updated or removed.

Project `config.memory.yaml` contains `autoApprove` (default false) and a `frameworks` map of names to exact versions. The separate app-data `config.memory.yaml` controls global auto-approval. The interface edits these files with revision checks; malformed files block use rather than silently resetting preferences. Project policy never approves a global lesson. YAML comments and unrelated keys are preserved.

Approved applicable pins and bounded keyword matches are supplied as reference material. Framework applicability uses exact configured versions. Draft, rejected, superseded, out-of-scope, or incompatible lessons cannot enter context. Each run retains the exact supplied lesson versions, text, framework inputs, and an explicitly estimated token count. Retrieval is local keyword matching; semantic retrieval and external memory integrations remain future work.

## Parent integration

Before a fresh code review, Randolph integrates an advanced clean parent into the managed conversation worktree. Preparation retains the original and proposed file contents outside the repository; an applying journal is durable before file changes. The parent branch and checkout remain unchanged during integration.

Disjoint changes continue into fresh verification. Conflicts are shown with paths and can be addressed through another coding message. Explicit conflict confirmation rejects remaining conflict markers; verification and final approval must run again. An interrupted apply is retained and blocks new execution until explicit continuation or reconciliation. Unexpected edits are preserved rather than overwritten during rollback.

The implementation supports detached managed worktrees and related clean parent history. Custom merge drivers, submodules, file/directory topology replacement, and integrations exceeding the retained-blob limits are rejected. Limits are 8 MiB per changed blob and 64 MiB of retained content. Partial interruption can require manual reconciliation; reopening never applies changes automatically.

## Separate origin push

Local commit, merge, and cleanup never push. A delivered review offers **Preview origin push**, which reads the configured origin and captures the exact branch, local commit, and remote commit. The local branch must still identify the delivered commit. A second explicit approval publishes only that previewed commit.

Push requires proven fast-forward ancestry and an exact expected remote revision. Remote changes invalidate the preview. Transport runs from an isolated temporary Git repository with hooks and repository helper overrides excluded. SSH uses an explicit unattended identity and strict host-key checking; authentication never falls back to an interactive agent or a model API.

The approval and operation marker are durable before execution. **Check origin outcome** reconciles the approved destination and commit, including when the local branch or origin configuration has subsequently changed. Reopening never retries a push. Unconfirmed transport cleanup quarantines the owning conversation, including failures during preview before a push plan exists.

Automated push evidence uses real local bare repositories through a test-only transport option. Actual SSH/HTTPS delivery is not certified by those fixtures. No external push was performed while implementing this capability.

## Verification

Runtime tests cover lesson scope, approval/version history, stale pins, settings revisions, exact context provenance, real Git integration/conflicts, and separate push approval/reconciliation. Electron acceptance covers lesson editing and pin updates, local delivery, and the separate push preview boundary. Broader lifecycle, checkpoint, harness, workflow, and distribution acceptance remains open.
