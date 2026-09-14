# Native Stop and owner-loss experiment

**Overall: unverified. Explicit Stop and controller-crash cleanup passed; harness-crash and detached-child cases were not reached.** The experiment stopped after its initial and single corrected attempts encountered process-observation errors. No live model inference was used.

## Observed outcomes

Recorded on 2026-09-12 UTC using Codex CLI 0.149.0, Node 24.18.0 and macOS arm64. Scripted local Responses messages launched real native shell tools under the previously verified isolated workspace policy.

| Case                                 | Corrected attempt                            | Evidence                                                                                                                                |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit Stop                        | Passed, 4.349 seconds from request to result | Dispatch closed; native cancellation requested; harness and observed tool descendants exited; no later heartbeat growth or canary write |
| Controller SIGKILL                   | Passed, 4.354 seconds from fault to result   | Independent supervisor detected IPC loss and stopped owned work before any reopening or watchdog rescue                                 |
| Harness SIGKILL                      | Unverified                                   | Process enumeration failed during setup, before this native case started                                                                |
| Rapid detached child                 | Unverified                                   | Not reached after setup failure                                                                                                         |
| Read-only reopen                     | Passed for both completed cases              | A fresh reader process showed `stopped` or `interrupted`; the journal retained exactly one scripted turn per case                       |
| Protected refs and unrelated process | Passed for both completed cases              | Worktree/parent/remote refs unchanged; unrelated sentinel remained alive during each assessment                                         |

Each active tool created an ordinary child and wrote recurring heartbeat bytes. Both processes were independently confirmed alive before the fault, with the exact native tool call recorded. The observer waited past the six-second delayed canary point and checked file stability. It recorded verdicts before any watchdog action. The observed native shutdown did not depend on reopening the controller.

The initial attempt also passed Stop in 2.301 seconds, then became unverified during setup of the next case. Across both attempts, three native scripted turns started and zero model inference calls were made. Total recorded probe duration was 7.445 seconds plus 23.126 seconds; offline development and manual cleanup are separate.

## Candidate and failure domain

The [supervisor](../../experiments/controlled-run/src/lifecycle-supervisor.ts) is a per-run child process with a dedicated controller IPC connection. It owns the App Server, records process identities before dispatch, and observes descendants periodically. Stop closes new dispatch and late permission grants, requests native cancellation, allows two seconds for graceful shutdown, then signals still-observed identities. The five-second result criterion includes IPC and owner-loss detection latency.

A small C helper obtains PID, UID, parent/group IDs and microsecond process start times through macOS `libproc`. A retained PID omitted from enumeration is not assumed dead: only an `ESRCH` liveness result establishes absence. Unavailable identity evidence produces uncertainty. Signal requests check the identity immediately beforehand, but lookup and signal are separate syscalls; this does not establish atomic immunity to PID reuse. [Apple's libproc interface](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h).

Each process writes its own ordered journal. A read-only state projection maps unfinished execution to `interrupted`; it performs no restart. This is not checkpoint restoration or a production Restart implementation.

Polling can miss a child that reparents between snapshots. The unexecuted detached fixture deliberately exits its parent immediately and does not register cooperatively with the candidate. The independent observer's fixture receipts are for verification and rescue only. This candidate cannot claim arbitrary descendant containment, supervisor-loss protection, OS-failure recovery or Electron lifecycle coverage.

## Errors, corrections and cleanup

Both attempts stopped on a process identity lookup that could not be certified. The first attempt's global enumeration error also prevented ordinary cleanup from proceeding. Its remaining test sentinel was subsequently terminated using its verified parent, command and native identity. The corrected runner attempts exact-PID cleanup independently even when whole-table enumeration is uncertain.

Review after the corrected attempt found an error in the helper's retry branch: even a successful repeated lookup fell through to the failure path. The final helper handles recovered lookups correctly and retries only a live, accessible process, avoiding delays for inaccessible system processes. A compiled C regression fixture exercises that branch. These corrections received offline verification; no third native attempt was run. The recorded observations are not relabeled as evidence for the final helper revision.

Automatic cleanup remained uncertified in both result files. Manual cleanup subsequently verified that lifecycle actors had exited and removed the marked disposable repositories, isolated Codex homes and helper scratch directories. Separate private cleanup records preserve that distinction; the original sealed evidence remains unchanged.

## Verification and next step

Lint, typecheck, build and all 37 offline tests passed. Verification covers dispatch closure, declined late approvals, read-only reopen, enumeration uncertainty, omitted live identities, PID-reuse rejection and compiled macOS process observation, including the retry regression. C builds use warnings as errors. The [explicit runner instructions](../../experiments/controlled-run/README.md#lifecycle-probe) remain separate from default tests. Independent review approved the bounded code and the two-pass/two-unverified assessment. The OSS scan passed with 11 inapplicable checks skipped.

The next bounded native pass should exercise the corrected observer and the two outstanding cases. A detached-child escape must be reported as a failed candidate, even if a watchdog removes it. M1 remains incomplete; checkpoint recovery and final delivery have not been implemented or verified.
