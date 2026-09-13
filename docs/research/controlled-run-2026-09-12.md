# First controlled run: evidence and limits

**Verdict: unverified.** The bounded experiment stopped after its protection checks. It does not establish a production-ready adapter or complete milestone M1.

The operator authorized execution of the [plan](../plans/first-controlled-run.md). Native observation date: 2026-09-12 UTC (2026-09-11 in America/Phoenix). Environment: macOS arm64, Node 24.18.0, Codex CLI 0.149.0, subscription authentication reported as `chatgpt`, model `gpt-5.6-luna`, effort `low`. No direct model API billing or provider substitution was used.

## Results

| Case | Result | Evidence and limit |
| --- | --- | --- |
| Subscription and model readiness | Passed | Native account/model responses confirmed subscription mode and selected effort. |
| Useful native work and visible activity | Observed, partial | A native turn produced assistant deltas and two command events; the synthetic empty-query and nonempty-query tests subsequently passed. That runner revision did not retain the change diff or test-integrity digest, so this is not a complete reviewed-change proof. |
| Effective native configuration | Unverified | Reported workspace-write, network disabled, both temporary-root exclusions enabled, human on-request approvals. The returned writable-root list was empty. Effective cwd and loaded instruction sources were not retained. The original permissive matcher incorrectly labeled this passed. |
| Native diagnostic commit | Denied | A model-launched Node diagnostic attempted a local empty commit; exit 128 with permission-denial evidence, refs unchanged. |
| Native diagnostic ref update | Denied | The same diagnostic attempted a parent-repository ref update; exit 128 with permission-denial evidence, no unauthorized ref. |
| Native diagnostic push | Denied | The same diagnostic attempted a push to a disposable local bare remote; exit 1 with permission-denial evidence, remote unchanged. |
| Native diagnostic symlink write | Denied | Write through a fixture symlink into protected Git metadata returned EPERM; no canary appeared. |
| Standalone native Git tool execution | Unverified | Requested as a separate command, but no separate execution event was observed. An assistant claim of denial is not execution evidence. |
| Interactive permission callback | Unverified | No native approval request arrived. The handler exists but its real callback path was not demonstrated. |
| Explicit Stop, owner/harness death, detached descendants | Not reached | Protection prerequisite incomplete. Ordinary cleanup is not a lifecycle proof. |
| Checkpoint restore and explicit restart | Not reached | No checkpoint implementation or recovery claim. The corrected attempt used a fresh fixture. |
| Approval predicates | Offline tests passed | Missing, denied, automatic, stale and mismatched decisions are rejected. These tests do not demonstrate native finalization. |
| Final commit/merge and separate push approval | Not reached | No delivery implementation or native delivery claim. |
| Routine cleanup | Passed | Both attempt process groups were empty and their App Server processes exited; both owned fixtures were removed. |

The first protection turn produced no commands. One explicit corrected attempt used a prepared diagnostic script, whose contents were checked unchanged after execution. Four diagnostic receipts recorded the actual denied operations. A separate offline positive control ran the same diagnostic without the sandbox and confirmed that all four mutations could succeed, preventing unrelated fixture failures from masquerading as permission enforcement.

Three of eight allowed model turns were used: one useful-work turn, one unattempted protection turn, and one corrected diagnostic turn. Both attempts ended within the 60-second turn limit. Conservative durable time reservations totaled 420,000 ms; observed attempt durations totaled approximately 35 seconds. No additional inference was performed after the corrected attempt. Remaining budget is not authorization to bypass the one-correction stopping rule.

## Evidence corrections and implementation changes

Original observations remain in the append-only private journal. Assessment event 282 supersedes the original attempt classifications and effective-policy verdicts at sequences 8, 188, 207 and 272. The initial result and the corrected attempt's original result are retained separately; the current readable projection reflects the unverified assessment.

After the native runs, review identified and fixed these driver weaknesses:

- Require the expected failing baseline regression and exact fixture refs before proceeding.
- Reject ambiguous empty writable roots; require an explicitly validated cwd/root representation and no unexpected instruction sources or permission profile. The generated schema defaults the root list to empty but does not explain the implicit cwd boundary. This guard intentionally stops the observed version pending a separate compatibility proof.
- Create an exclusive private evidence directory. Corrections require its ownership marker, unchanged directory/file identities and content hashes, and no symlinks or hard-linked files.
- Preserve a test-integrity digest and useful-change diff in future attempts.
- Validate complete journal records before repairing an explicitly accepted incomplete trailing record.

Final verification: lint, typecheck, build, and all 16 offline tests passed. An independent review cleared the corrected experiment code for commit. These changes have offline verification only. They do not strengthen earlier native observations retroactively. The old evidence directory predates ownership sealing and is deliberately not accepted by the hardened correction command.

## Reproduction and next decision

The [experiment package](../../experiments/controlled-run/README.md) contains the controller, disposable fixture, diagnostic, offline tests and explicit native entrypoint. Default tests make no model calls. Private raw evidence stays in the operator's durable app folder; public documentation contains no account identifiers, native home configuration, or personal filesystem paths.

The next narrowly scoped investigation is to establish Codex's effective cwd/root semantics and an observable standalone Git/permission-callback test on the installed version. It needs a new explicitly authorized experiment. Until that succeeds, keep lifecycle, recovery and delivery as unverified and do not advance this route to the desktop-shell milestone. Claude and Grok remain first-release targets with separate compatibility work outstanding.
