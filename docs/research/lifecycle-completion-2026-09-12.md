# Completed lifecycle experiment: detached-child escape

**All four cases executed. Overall verdict: failed.** The supervisor successfully stopped ordinary work after Stop, controller death and harness death. A rapidly detached child escaped process-tree observation, continued writing and required independent watchdog rescue. The lifecycle experiment is complete as research; this implementation does not satisfy Randolph's containment requirement and must not be promoted as a verified production adapter.

## Results

Codex CLI 0.149.0, Node 24.18.0, macOS arm64. The completed probe took 28.645 seconds, used four local scripted turns and made zero inference calls.

| Native case | Fault to supervisor result | Result |
| --- | --- | --- |
| Explicit Stop | 2.264 s | Passed; actors exited, no later heartbeat or canary |
| Controller SIGKILL | 2.270 s | Passed; IPC loss triggered shutdown before reopening |
| Harness SIGKILL | 2.352 s | Passed; surviving observed tool descendants terminated |
| Rapid detached child | 2.271 s | Failed; detached child remained alive, heartbeat grew and delayed canary was written |

All cases preserved fixture refs and the unrelated sentinel. Reopening added no turns. However, the detached case exposes a false assurance in the candidate's state projection: it reported `stopped` because its tracked set was empty, while the independent observer found the untracked child still alive. Consequently, a `stopped` event from this research supervisor cannot certify complete shutdown.

The detached child had already reparented to PID 1 and started its own process group. It was absent from the candidate's retained identities. The observer recorded the failure before signaling that exact independently verified child. Watchdog rescue does not change the failed verdict.

## Setup correction and cleanup

The renewed first attempt passed Stop but encountered another process lookup failure during setup. The observer was querying a newly forked controller before its runtime was ready. The final probe waits for a controller readiness message and obtains initial identities through bounded exact-PID lookup before sending a start instruction. This changes setup synchronization; runtime identity uncertainty still stops execution. A new offline test verifies that readiness is emitted before any supervisor or native dispatch.

Both renewed attempts preserved their original result files, including `cleanupPassed: false`. All recorded actor, controller, supervisor and harness identities were subsequently confirmed exited. Marked fixture repositories, isolated native homes and helper scratch were removed manually, with separate private cleanup receipts. The earlier [partial observations](lifecycle-2026-09-12.md) remain unchanged.

## Consequence

Polling process trees and killing process groups is insufficient for Randolph's promised Stop-all behavior. Increasing poll frequency does not establish a guarantee against rapid reparenting. The product requirement remains intact; a stronger containment mechanism is a release blocker. Checkpoint capture and restoration can be developed and tested independently without presenting this failed supervisor as production-ready.

The operator has been asked whether sandbox research should move forward now or the containment decision should remain an explicit release blocker while independent work continues. No daemon, privileged account, system extension or sandbox platform has been introduced by this experiment.
