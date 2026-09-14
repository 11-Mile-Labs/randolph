# Initial harness compatibility findings

Evidence date: 2026-09-11. Status: observed results from bounded disposable probes, not a production support matrix. No installable Randolph application exists yet.

The probes ran on macOS with installed CLIs and existing subscription authentication. They used synthetic repositories and local bare Git remotes. No direct model API or API-billing fallback was used. This public summary omits private operator paths, account identifiers, native session IDs, and raw logs. Probe source and complete evidence are not included in this repository; the [next experiment](../plans/first-controlled-run.md) must produce a reproducible public-safe fixture and evidence format.

## Results

| Capability              | Codex CLI 0.149.0                                                                               | Claude CLI 2.1.268                                  | Grok CLI 1.0.25                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Native connection       | App Server initialized                                                                          | Structured CLI streaming worked                     | ACP initialized; session created                                                     |
| Subscription path       | ChatGPT account observed                                                                        | First-party claude.ai subscription observed         | CLI-owned cached browser token accepted                                              |
| Model and effort        | Native catalog returned; lightweight model and low effort used                                  | Lightweight alias and low effort accepted           | Current model reported; low effort requested                                         |
| Visible work            | Assistant deltas and command lifecycle events observed                                          | Assistant deltas and Read-tool events observed      | File created, but no useful progress stream or terminal prompt result before timeout |
| Protected Git operation | Tight host-command sandbox blocked commit; two model-driven attempts committed without approval | Restricted Bash commit/push denied before execution | No permission callback observed; local remote unchanged                              |
| Explicit stop           | Host command termination stopped parent and child                                               | Running-child cancellation unverified               | Live-tool cancellation unverified; timeout cleanup of owned process groups succeeded |
| Abrupt harness death    | App Server SIGKILL left command descendants running                                             | Unverified                                          | Unverified                                                                           |
| Continuation            | Fresh session recalled explicitly supplied context marker                                       | Native resume recalled prior marker                 | Session load timed out                                                               |

## Interpretation and limits

### Subscription startup is feasible; execution control is incomplete

Each harness exposed a native route using its own subscription authentication. That establishes a technical integration path for the tested environment, not vendor endorsement, availability on every subscription, or production support. Authentication must remain harness-owned. Record effective mode and refuse an automatic API fallback.

### Codex permission settings require a controlled follow-up

A host-issued command under explicit workspace roots and temporary-directory exclusions wrote an ordinary file but could not acquire the shared Git metadata lock. Two model-issued commits succeeded without an approval callback.

The tests did not use identical effective boundaries. The first model probe inherited execution-host environment variables. The follow-up scrubbed them, but its named workspace profile permitted OS temporary roots, and the fixture lived under one of those roots. Existing native user rules were not replaced. These observations show that the tested integration did not enforce Randolph's final-approval requirement. They do not establish an inherent Codex defect or impossibility of enforcement.

The next proof must isolate effective configuration and test the actual model-tool path, including alternate routes to Git metadata and network actions. An application-owned Git button does not constrain the agent's independent shell.

### Process death does not imply descendant cleanup

Explicit Codex host `command/exec/terminate` stopped a command and its child. Abrupt App Server SIGKILL left both running at the half-second observation. Exact-PID cleanup then removed them. This was a host-command test, not model-tool cancellation.

Randolph needs a verified process ownership and owner-loss mechanism. Renderer failure, desktop-host failure, runtime failure, harness failure, and detached descendants are distinct cases. Reopening must reconcile evidence without automatically resuming execution.

### Claude approval hosting remains unproven

Restricted execution denied Bash before the protected commit/push or sleep command ran. Streaming and native continuation worked, but no custom interactive permission responder was implemented. No running child was available for a cancellation proof. Completed probes also inherited execution-host variables; the runner was subsequently corrected without an inference rerun.

### Grok silence concealed real work

The final isolated ACP attempt created the requested file while no useful assistant stream or terminal prompt result reached the client before timeout. Session load also timed out. A successful handshake and advertised capabilities are insufficient to mark these behaviors supported.

The cause remains unassigned between client integration and harness behavior. The installed CLI changed from 1.0.24 to 1.0.25 during testing without an explicit updater command; launch-time self-update is suspected but was not independently established. Record the executable identity at each launch.

## Required follow-up

1. Prove effective permissions on native model-driven tools, with separate final delivery and push authority.
2. Prove explicit stop and owner-loss cleanup, including descendants, without relying on reopening the app.
3. Restore code, artifacts, context, and pending work after original worktrees are removed. Marker recall alone is insufficient.
4. Expose last confirmed activity and stale reporting separately from process liveness; do not blindly retry timeouts that may have produced effects.
5. Apply the same acceptance contract separately to every supported harness version.

All identified probe processes were cleaned up. Disposable repositories were removed or moved to operating-system Trash. Native harnesses may retain their own session metadata. None of these results certifies full checkpoint recovery, delegation, pause, concurrent execution, stale-approval handling, or finalization recovery.

## Primary interface references

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Claude programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Grok Build](https://docs.x.ai/build/overview)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)

These references describe integration surfaces. The observed results above come from the probes, not from assuming that documentation implies tested behavior.
