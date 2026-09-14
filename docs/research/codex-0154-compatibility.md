# Codex CLI 0.154.0 compatibility

Date: 2026-09-12. Scope: the installed macOS arm64 CLI, existing production Codex adapter, and bounded deterministic native probes. This supports adding exactly `codex-cli 0.154.0` alongside exactly `0.149.0` for controlled coding and verification. Prereleases and other versions remain unverified.

## Evidence

Live subscription discovery returned six models, including GPT-6 Astra. The command probe used the production adapter with only the old version comparison bypassed after checking the actual executable version. The turn probe additionally substituted a local deterministic Responses fixture. That fixture is test infrastructure; production retains ChatGPT subscription authentication and the OpenAI provider. No hosted model inference or API fallback ran during these probes.

The effective native policy reported the canonical worktree, approval policy `never`, workspace-write permission, no network access, both temporary-directory exclusions, and no active permission profile. Additional writable roots normalized to an empty list while the runtime workspace roots contained exactly the worktree.

| Case                                  | Observed outcome                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Ordinary workspace write              | Exact contents written; exit 0                                                               |
| Parent checkout write                 | Denied; no file created                                                                      |
| Linked-worktree Git metadata mutation | Denied at the parent Git metadata lock; refs and indexes unchanged                           |
| Loopback network access               | Denied; listener received zero requests                                                      |
| Verification Stop                     | Native terminate request sent; command PID gone; cleanup verified                            |
| Production adapter turn               | Ordinary write completed with a command event; protected Git mutation denied                 |
| Turn Stop                             | Native turn interruption completed; owned process groups empty                               |
| Explicit approval experiment          | Declined elevation denied; one positive-control approval changed only the synthetic worktree |

## Remaining gaps

A failed, non-escalated command in a 0.154 model turn returned its exit-128 tool result without the expected `commandExecution` notification. The denial and unchanged Git state were verified, but Randolph could not emit its normal command-completion event for that attempt. Direct verification through `command/exec` retained the failure result. The older scripted probe's overall verdict therefore remains `unverified` under its original event assertion; it is not reported as an all-green probe.

The independent experimental supervisor contained controller and harness death. It is not part of production Randolph. A detached child still escaped, continued running, and wrote a late canary until the experimental watchdog rescued it. Production owner-loss and detached-descendant containment remain release blockers. This compatibility increment does not establish full lifecycle containment or application-level sandboxing.

The current effective-policy validator covers cwd, approval, sandbox type, additional writable roots, network, and temporary-directory exclusions. Runtime workspace roots and instruction-source metadata were inspected in this probe but are not independently asserted by that validator. The local global instruction source remained present despite project document suppression; context-management work remains incomplete.

## Retained evidence identity

Raw local probe artifacts are retained separately from the public repository. SHA-256 identifiers:

- Command `results.json`: `7f3af972e038f20393627ebd51338a2bf3b2c45957756bcdc76d745c6b15751b`
- Adapter `turn-results.json`: `509cda60c6204ebec7b96a6ebf8f58767293a57a3f0ff41d5c84941a6fe1eb45`
- Lifecycle `results.json`: `5d20ae1082204f9c8452e37a1dfc7ea6cd61b25b4f5cced38d092a926dec8ca0`
- Scripted Git `results.json`: `53a99bd4dc3e124755be71656bfb11124411312b892ccccc42600ecd7aee52f8`

The 0.154 scripted tool fixture used `exec_command` with `cmd` and `yield_time_ms`; the previous `shell_command` fixture shape required adaptation. Adapter tests cover exact version gating, normalized policy, Code dispatch, command verification, and rejection of broader effective permissions. These tests complement the native evidence above; scripted unit fixtures alone do not certify native behavior.
