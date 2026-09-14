# User journey: from project setup to approved bugfix

Status: design walkthrough, not an implementation specification or a live execution report. This document applies the [approved product specification](product-spec.md). Illustrative content and additional proposals below are not newly approved requirements.

## Scenario

An individual developer opens an existing repository named Atlas and fixes a bug: clearing a search field leaves the list empty. Other conversations can be running in this project and elsewhere.

For this example, the user explicitly selects a saved Bugfix workflow and a saved preset requiring the selected main agent to implement and a separate agent to review. Those example workflow requirements and preset contents are not mandatory defaults for every bugfix. Automatic planning otherwise starts with the main agent alone.

## 1. Add the project

**User sees:** an existing-folder selector, discovered harness readiness, and a project setup summary for review.

**Application does:** discovers available installed CLIs and inspects the repository for project purpose, important documents, and development conventions. It presents inferred facts and uncertainties, asks focused follow-up questions, and obtains approval of the project understanding. The user chooses enabled harnesses and the default main harness/model/effort. Balanced is the initial routing preference.

**Result:** Atlas appears in the project sidebar. The project has a reviewed definition and common instructions, agents, hooks, and skills. Existing harness configuration is not imported. Setup can be rerun with reviewable changes while preserving customization.

**Approved behavior:** perform local harness discovery first and show readiness. The user chooses a ready setup harness, model, and effort before AI-assisted inspection. The agent inspects the project and presents its understanding for approval. Offer to retain that agent configuration as the project default. If no harness is ready, show setup-needed guidance with no silent API fallback.

## 2. Start the conversation

**User sees:** the main-agent controls, Balanced preference, chosen Bugfix workflow and preset, and an enabled worktree indicator. They can start from a local or Linear backlog item, or enter the request directly.

**User action:** enters “Clearing search leaves the list empty; restore the full list,” then attaches the search behavior document with `@` or the `+` menu. Skills can be selected with `/` or the menu. Reference chips are removable before sending.

**Application does:** establishes the conversation's run, snapshots its starting configuration, prepares relevant context with pinned material retained, and creates the conversation worktree inside the repository. Retained run material is organized globally; scratch material uses temporary storage.

**Approved behavior:** show the currently checked-out branch as the default parent before starting, with the option to choose another branch. Leave pre-existing uncommitted changes in the original checkout by default. Users can explicitly include a copy in the new worktree; original changes remain in place. Detailed handling of copying changes onto a different selected branch still needs design.

## 3. Authorize the approach

**User sees:** a compact authorized-preset banner identifying the main implementer and independent reviewer, including their harnesses, models, and supported effort settings.

**Application does:** treats the explicitly selected preset as authorization. The main agent investigates and implements; the reviewer waits for a reviewable result. There is no extra planning agent merely to choose those assignments, and no silent replacement of the selected main agent.

**Alternative path:** with automatic planning, the main agent begins alone. If it identifies a concrete benefit from delegation, it presents the proposed assignments, rationale, dependencies, limits, and deliverables in an approval card. The user can edit the card or request a conversational revision, approve the displayed version, and separately choose whether to save it as a project preset. When a workflow and assignments are both proposed at startup, combine them into one editable card covering the complete plan, limits, and expected outcomes. One approval authorizes that displayed plan. Saving a workflow or delegation preset remains separate. Approval covers the displayed combined revision.

## 4. Work with visible activity

**User sees:** concrete activity such as “Inspecting the query reset handler,” “Applying the fix,” and “Running search regression checks.” The reviewer is visibly waiting rather than represented as working. Elapsed execution time and the freshness of reported events are available without opening logs.

**Application does:** records assignments, prepared context and provenance, tool activity, results, and state changes. Where a harness supplies limited information, the UI reports the last confirmed event and its age rather than inventing progress. Usage/context values distinguish measurements, estimates, and unavailable information.

The user can switch projects. Working, unread, and approval indicators remain visible in the sidebar; actionable requests also appear in the shared attention inbox and optionally macOS notifications.

Independent read-only research may run alongside implementation. If parallel writers become justified and authorized, they receive separate worktrees; the coordinator integrates their changes and verifies the combined result.

## 5. Review and verification

**User sees:** the implementer's result and verification evidence, followed by the independent review required by the selected example preset. A reviewer is not represented as independent if it authored the reviewed change.

**Application does:** handles permitted fixes within the selected workflow's repair limits. It distinguishes infrastructure retries from code-repair attempts. Exhausted limits request approval even in YOLO mode. Adding or changing an agent follows the approval mode and produces visible, versioned evidence.

Before requesting final approval, the coordinator updates against the latest parent branch, resolves conflicts, and verifies the combined result. Another conversation finishing first can therefore cause additional integration work. There is no claim of completion while the required verification outcome is unresolved.

## 6. Final approval and delivery

**User sees:** an attention request that opens the conversation's final review. It includes the resulting behavior, changed files and combined diff, verification and review evidence, and the target parent branch. The action commits all non-ignored worktree changes and merges to that parent. Pushing remains a separate explicit action.

**Application does:** binds approval to the displayed revision and verified parent revision. A changed deliverable or parent invalidates a pending request, leads to updated verification, and requires a replacement approval. Final approval remains manual in YOLO mode.

Following a successful merge, the application removes the temporary worktree and branch, retains run history, and advances a linked issue according to the project's workflow mapping. A failed Linear update is shown as pending reconciliation; it does not hide the successful local delivery.

**Approved behavior:** track and display the confirmed outcome of each delivery step: commit, merge, cleanup, and issue update where applicable. After an interruption, reopening checks what completed and waits for explicit user continuation of unfinished steps. Do not repeat completed actions or automatically restart agents. Continuing with a changed approved result or target branch requires fresh verification and approval. Technical details still include the final parent/revision check, serialization, and reconciliation when an action completed but its outcome was not durably recorded.

## 7. Learn and revisit

**User sees:** any proposed lessons grouped for review under the project's memory policy. A lesson should express reusable, evidence-supported knowledge, rather than merely restating the task. Global lessons use the separate app-wide approval setting.

**Application does:** stores accepted lessons in built-in memory, records their evidence and scope, and optionally writes approved lessons to an enabled integration. Historical runs retain the exact lesson/context versions used rather than changing when memory is updated.

The user can review the historical timeline without execution. They can explicitly request a new linked rerun from a retained checkpoint, using saved configuration and context and obtaining required approvals again. The original history remains unchanged; model outputs are not promised to repeat.

## Interruptions along this journey

| Event                                                  | Expected experience                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User selects Pause                                     | New dispatches stop; Pausing remains visible until active operations reach a safe boundary. Resume continues paused work.                                      |
| User selects Stop                                      | All app-managed delegated work is stopped; process-exit status is reported honestly. Restart is an explicit action from the last completed checkpoint.         |
| User quits or the app crashes                          | Unfinished execution is lost; retained history remains. Reopening never automatically restarts work.                                                           |
| Execution budget expires                               | Stop new dispatches, pause at a safe boundary, and request extension even in YOLO mode.                                                                        |
| Harness has no recent events                           | Display last confirmed activity and age; do not imply progress solely from a spinner.                                                                          |
| Required harness becomes unavailable                   | Surface the interruption. Do not silently replace an approved assignment or switch to API billing. Exact user choices and recovery behavior still need design. |
| Another conversation is writing in the shared checkout | If isolation was disabled, show the waiting writer and which conversation holds write access. Separate worktrees proceed independently.                        |

## Recovery ownership

**Approved:** Resume continues the same run. Restart after a stop or interruption creates a new linked run inside the same conversation, retaining the previous run in its history. Deliberately rerunning an earlier result opens a new linked conversation. A conversation has at most one active run, with historical runs retained.

**Checkpoint contract:** automatically checkpoint meaningful completed steps without requiring another approval or extra agent. Preserve code, retained artifacts, completed and pending work, relevant decisions, restart configuration and context, and completed external actions. Label a checkpoint recoverable only after all required material is durably saved.

Remaining technical design includes copying uncommitted changes onto a different selected branch, checkpoint restoration, finalization serialization, and external-action reconciliation. These details are not implicit additions to the approved brief.
