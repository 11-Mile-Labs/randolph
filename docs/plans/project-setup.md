# Project setup and approved context

Status: implemented and independently reviewed under the approved [product specification](../product-spec.md) and [working application plan](working-application.md). All required checks and nine desktop acceptance tests passed; see [verification evidence](../research/project-setup-2026-09-12.md). This increment does not complete the full harness/context/workflow scope.

## User flow

Project context is reachable from Workspace and the project sidebar. It shows the approved purpose, instructions, and document references from `config.project.yaml`. A user can select an installed ready Codex CLI/model/effort and supply an idea or corrections before requesting inspection. Additional harness adapters remain separate work.

Inspection runs read-only against the registered project folder, records native activity in a dedicated setup conversation, and never writes project configuration automatically. An empty folder with an idea can receive a proposed project definition; Git initialization and full new-project code delivery remain separate from defining that idea.

The completed inspection produces a bounded structured proposal with purpose, instructions, document references, evidence, and unresolved questions. The current approved values remain visible beside the editable proposal. Follow-up inspection incorporates corrections and preserves the earlier run history. Opening or reopening this view never starts inspection.

Approval is tied to the selected proposal's recorded revision and the context file's starting revision. A newer proposal or external context edit makes an old approval stale. Approval writes only the displayed context fields, preserving unrelated YAML and comments. Invalid model output stays visible as an inspection problem and cannot become approved configuration. Choosing the setup agent as project default is a separate action through the existing harness-settings API.

The registered directory's canonical path, device, and inode are checked during admission, native dispatch, and approval. Replacing or redirecting that directory invalidates the inspection. Generic chat submission cannot dispatch into setup conversations. Edited proposals survive activity updates and follow-up inspection; accepting a newer proposal requires explicit Reload.

Approval records intent before writing YAML and a receipt afterward. These are separate persistence operations. If the file write succeeds but the receipt fails, the view refreshes the actual saved configuration, reports the unconfirmed receipt, and disables repeat approval. A new inspection is required to establish another proposal.

An interrupted inspection with unconfirmed cleanup remains quarantined. New runs record a hashed Mac identity and boot-session identifier. The explicit **Verify inspection cleanup** action can reconcile a run only on its original Mac after a different boot session, with no locally owned execution or admission in progress. It records reconciliation and leaves the old run interrupted; it never restarts or approves it. Same-boot, copied-machine, malformed, and legacy records without origin evidence remain blocked. This limited recovery mechanism does not solve the application-wide detached-descendant or owner-loss lifecycle requirements.

Normal conversation runs retain the approved context value and file revision at admission and supply that frozen value to the harness. Checkpoints and linked execution retain the same context rather than reading newer project settings. Document references are retained as references; copying document contents, rich previews, skills/hooks portability, and context budgeting remain separate work.

## Implementation checklist

- [x] Versioned context YAML persistence with safe paths, bounds, stale-save protection, and tests.
- [x] Read-only setup run orchestration, proposal parsing, retained history, explicit approval, and safe rerun.
- [x] Frozen approved context supplied to normal runs and retained across checkpoint recovery.
- [x] Discoverable project context view, model selection, activity/Stop, comparisons, questions/corrections, approval, and optional default-agent save.
- [x] Runtime and Electron acceptance covering cancellation, no automatic execution, stale proposals/configuration, context pinning, and unchanged source files before approval.
- [x] Full required checks, independent review, and coherent local commit.
