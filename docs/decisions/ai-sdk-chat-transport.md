# AI SDK chat transport

Status: implemented desktop integration of the accepted [architecture](../architecture.md#3-ui-transport-and-agent-communication). This changes presentation and transport; the [complete product specification](../product-spec.md) remains the acceptance target.

## Ownership

Electron/React uses AI SDK UI `useChat` with an application-owned `ChatTransport`. The transport submits a text command through the existing validated preload bridge. The runtime supplies conversation history, selected executable/model/effort, prepared lessons, worktree, and permissions. A renderer-provided transcript cannot replace those execution inputs.

Execution continues through the installed subscription-authenticated Codex App Server. Claude and Grok remain required adapter work. No provider/model generation API or AI Gateway call is introduced. The SDK has transitive provider dependencies, but this integration invokes only chat presentation and streaming interfaces.

Randolph retains coordination and execution authority. The SDK transport does not authorize delegation, approve delivery, raise execution limits, or replace the runtime's process controls. Scoped coordination tools, additional harnesses, presets, and scheduling remain unfinished.

## Streaming and reconnecting

SQLite messages and ordered native events remain authoritative. Historical messages are projected into SDK messages. A run's native assistant messages appear as separate text parts in one response identified by the run; original native message identities and individual timestamps remain in the durable history. Imported checkpoint context keeps its original sequence of user and assistant messages, separate from the new run's response.

Each streaming connection subscribes to runtime changes before reading the first event batch. It reconstructs the selected run from retained events, then advances a sequence cursor. Duplicate notifications do not append the same delta twice. Serialized reads coalesce changes arriving during an event read. Events from another conversation/run, reasoning, commands, approvals, and file changes cannot become assistant text.

Reconnect rebuilds the current response from its beginning under the same identity, replacing its prior partial presentation. It does not issue a new send command. A validated, conversation/run-scoped IPC query returns the run state and all durable events after the supplied sequence in one synchronous runtime read. Chat replay is independent of the activity snapshot's latest 2,000 global events. Global sequence gaps caused by other runs are normal; the indexed run query does not discard older events. Bounded transport buffering remains future performance work.

Switching conversations or detaching a renderer releases that view's stream listener without stopping native work. Reopening a live conversation reconnects; opening terminal history only renders stored state. App reopening retains the existing rule that interrupted execution never restarts automatically.

## Sending, errors, and Stop

The composer acknowledges a send when the runtime admits it, allowing navigation and other conversations to proceed while native execution continues. SDK optimistic messages are reconciled to SQLite identities when the stream settles. A rejected admission restores the recorded history and leaves the draft available to correct and resend.

Stream/storage failures remain visible and release their listeners. **Reconnect chat** reloads the native stream without retrying inference. Native failed and unconfirmed-stop states remain errors; a finished UI stream is not proof that native work stopped. The activity panel continues to show the runtime's confirmed status and evidence.

The existing **Stop run** command still waits for runtime cancellation. An explicit SDK abort also addresses the exact admitted run, including when cancellation arrives while admission is pending. Merely cancelling the stream reader does not stop native execution. SDK regeneration is rejected; explicit linked Restart/rerun remains in Run history with its established checkpoint and approval rules.

## Verification

Transport tests consume real SDK streams and exercise run isolation, multiple native text parts, duplicate notifications, reconnect, cancellation during admission, view detachment, storage errors, rejected admission, optimistic-message reconciliation, checkpoint history ordering, and replay while more than 2,000 unrelated events exceed the workspace activity window. Electron acceptance runs two concurrent scripted native sessions, reloads the renderer during streaming, stops a running turn, and reopens history while asserting no extra native dispatch and no renderer errors. Tool and reasoning fixture output stay outside assistant messages.

These tests use scripted CLIs and no model inference. They do not certify additional native harnesses, descendant cleanup, owner-loss handling, or complete v1 support. The same chat acceptance also passes against the packaged macOS application, together with navigation/settings, executable selection, and checkpoint recovery acceptance; the bundle passes ad hoc signature verification.
