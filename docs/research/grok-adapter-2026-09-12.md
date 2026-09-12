# Grok adapter compatibility checkpoint

Evidence date: 2026-09-12. Status: discovery integrated; native execution disabled after a failed workspace-boundary probe.

This follow-up applies to `grok 1.0.25 (f7e67d6988e2) [stable]` on macOS. It does not supersede the unresolved failure causes in the [initial compatibility probes](harness-compatibility.md). Newer CLI versions are refused until their compatibility is checked.

## Implemented route

The adapter uses native ACP over a dedicated CLI's standard input/output, with launch-time auto-update disabled. Authentication uses the existing native profile's cached subscription login. The adapter checks native OIDC authentication, subscription tier presence, and disabled API billing, scrubs provider environment variables, and rejects custom provider overrides. It never reads or transfers tokens.

The per-launch agent definition requests only `read_file`, disables instruction and skill discovery, and excludes delegation and MCP discovery/call tools. This temporary definition is not a separate authenticated profile. Existing native hooks/plugins/MCP initialization can still occur; the adapter does not establish full profile isolation. See the [profile decision](../decisions/native-harness-profiles.md).

The implemented ACP host file-read callback is bounded to regular text files of at most 1 MiB inside the canonical workspace. Outside paths, escaping symlinks, write requests, terminal requests, permission escalation, and unknown callbacks are refused. Both read-only and Code execution remain unavailable in the runtime and desktop. These host callback controls are covered by scripted protocol tests; they alone do not prove that every native tool route respects the requested tool restriction.

## Native observations

- The existing subscription login was accepted without another login or API fallback.
- The model catalog returned Grok 4.6 and Grok 4.5 with their native reasoning-effort choices.
- The CLI reasoning-effort flag alone did not control a new ACP session: a low-effort launch produced a high-effort session. Supplying `session/new` metadata `reasoningEffort` produced the requested value. The adapter now verifies the session's reported model and reasoning effort before sending the prompt.
- The production adapter read a synthetic README, streamed its verification word, and received `end_turn`. The model reported writing unavailable when also asked to create a file; no requested output file appeared and the README was unchanged. This is an observation, not a deterministic proof of denied write-tool execution.
- Explicit Stop during native activity returned `interrupted` after owned process-group cleanup.
- Native retained prompt context confirmed the supplied full prompt, empty agent instruction sources, and disabled memory. This does not prove all global extensions were disabled.

## Remaining acceptance

Independent review requested native negative-route evidence. A subsequent production-adapter probe presented a synthetic workspace symlink targeting a synthetic sibling file. Grok read the outside sentinel successfully, while a transport observer recorded zero `fs/read_text_file` callbacks and zero host denials. The native read tool bypassed Randolph's callback. This is a failed boundary test, not an unverified assumption. Discovery therefore advertises no execution modes; both normal dispatch and checkpoint recovery reject execution before a prompt is sent. Global extension startup, native write/terminal routes, and inherited configuration must not be inferred safe from a successful read or from the model choosing not to write.

Owner-loss handling and detached-descendant cleanup remain separate application lifecycle work. Normal explicit Stop does not establish those guarantees. Separate profiles remain a post-v1 product and architecture review, and sandbox/VM expansion remains deferred.

## Automated coverage

The package protocol tests cover subscription-only admission, model/effort confirmation, session-scoped text streaming, distinct tool activity, cancellation, version drift, provider overrides, and bounded host callbacks. Runtime tests cover exact harness dispatch, captured run identity, project-default changes, review routing, legacy Codex recovery, and unsupported Grok Code admission. Desktop acceptance now covers Grok project selection and catalog loading, disabled execution with its reason, direct IPC rejection, and switching to a usable Codex conversation override while the project retains an explicitly selected Grok executable. Scripted transport tests do not establish native enforcement.

The AI SDK remains the UI transport layer. Native execution, selected harness identity, durable history, recovery and approvals remain owned by Randolph's runtime.
