# Grok adapter compatibility checkpoint

Evidence date: 2026-09-12. Status: discovery integrated; native execution remains disabled while Grok-only Code execution is being verified.

The initial observations below apply to `grok 1.0.25 (f7e67d6988e2) [stable]` on macOS. The current candidate is pinned to `grok 1.0.30 (04b7ffed98c6) [stable]`. This does not supersede the unresolved failure causes in the [initial compatibility probes](harness-compatibility.md). Newer CLI versions are refused until their compatibility is checked.

## Implemented route

The adapter uses native ACP over a dedicated CLI's standard input/output, with launch-time auto-update disabled. Authentication uses the existing native profile's cached subscription login. The adapter checks native OIDC authentication, subscription tier presence, and disabled API billing, scrubs provider environment variables, and rejects custom provider overrides. It never reads or transfers tokens.

The initial per-launch agent definition requests only `read_file`, disables instruction and skill discovery, and excludes delegation and MCP discovery/call tools. This temporary definition is not a separate authenticated profile. Existing native hooks/plugins/MCP initialization can still occur; the adapter does not establish full profile isolation. See the [profile decision](../decisions/native-harness-profiles.md).

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

## Grok 1.0.30 follow-up

The updated installed CLI accepts the existing subscription login. The original read-only handshake still reproduced the outside-symlink read with zero host callbacks. The cause is a native capability conjunction: Grok selects its ACP filesystem only when the client advertises **both** `fs.readTextFile` and `fs.writeTextFile`. With just one capability, it selects local filesystem access. This behavior is visible in the [native agent setup](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs) and [ACP session spawn](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs).

Advertising both handlers produced two native read callbacks, one host denial, the inside sentinel only, and unchanged files. A separate synthetic write-denial probe exercised an actual ACP write callback: the host rejected it and no requested file appeared. That negative probe exposed `write_file` in the profile before catalog validation existed; it is evidence of callback routing only, not a restricted native toolset.

The candidate now owns both handlers. Read-only still denies writes; experimental Code uses a persistent `WorkspaceFiles` instance for bounded UTF-8 file creation and replacement. It protects Git metadata, rejects symlinks/hardlinks and path aliases, and retains read/published-file fingerprints to detect ordinary external edits. These portable filesystem checks do not claim containment against a hostile concurrent filesystem actor.

Native tool names matter: the write tool is `write`, not `write_file`. An unmappable allowlist entry can cause Grok to keep its default toolset ([native builder](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/builder.rs)). The candidate therefore requires the exact session catalog before sending a prompt and rejects later expansion. Scripted tests cover missing, foreign-session, duplicate, unexpected, and late-expanded catalogs.

A real Code probe with `[read_file, write]` initially confirmed that exact catalog and performed one mediated read. Grok then asynchronously appended inherited MCP tools to the catalog despite the profile's `mcpInheritance: none` and disabled MCP metatools. Randolph terminated the run; no file write occurred. This is a newly demonstrated integration blocker. The native create/edit acceptance is **not passed**. Merely delaying the prompt, ignoring added tools, or trusting the model to avoid them is not a solution.

## Accepted execution constraint and remaining work

The user requires Grok-only execution, including project checks. The proposal to use Codex's no-inference command runner for Grok reviews was rejected. Do not introduce that dependency or silently change the selected harness.

The host file implementation and protocol tests are necessary groundwork; they are not complete Grok Code support. Remaining acceptance includes session-level inherited-tool exclusion, native positive creates/edits and protected-path rejection, native command/check enforcement, cancellation, and complete runtime review/delivery integration. A no-inference native terminal probe accepted `_x.ai/terminal/create` with client terminal capability disabled and no permission requests. The synthetic command wrote outside its supplied workspace and replaced synthetic `.git` metadata. The subsequent wait request was rejected for its schema, so this is evidence of those file effects, not a complete terminal-lifecycle proof. Grok's terminal extension does not itself provide the required permission boundary; on macOS its built-in sandbox profiles do not block child network access. Broader sandbox/profile work remains subject to the existing product decisions. Public execution stays disabled until the required route is proven.

Source inspection explains the inherited-tool result: an empty client `mcpServers` list is merged with native configured/plugin servers in [session setup](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L218-L239) and [server resolution](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs#L397-L418). Updating session servers repeats that merge. MCP toggles persist saved configuration, so they are unsuitable as temporary per-run controls. This upstream source snapshot explains the observed behavior but is not a version-pinned guarantee for the installed binary. No global MCP setting was changed.
