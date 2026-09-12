# Codex application-tool compatibility

Evidence date: 2026-09-12. Status: bounded native callback proof passed for installed `codex-cli 0.154.0`. This is a prerequisite for application-owned delegation, not an implemented delegation feature or a complete lifecycle proof.

## Interface

Version-generated schemas expose `thread/start.dynamicTools`, the server-originated `item/tool/call` request, and a response with `success` and `contentItems`. The callback carries native thread, turn, call, namespace, and tool identities plus arguments. The response uses the original JSON-RPC request ID. Initialization enables the experimental API.

## Native observation with current adapter controls

A private synthetic transport wrapper ran the compiled current `CodexAdapter.discover` and `CodexAdapter.run`, preserving their native process launch, environment, subscription check, permission settings, interruption, and process-group cleanup. The wrapper added one harmless dynamic tool to `thread/start` and handled only that exact callback; it did not change runtime or adapter source.

Discovery confirmed the installed version, ChatGPT authentication, and availability of `gpt-5.6-luna` with low effort. The run selected that model and requested low effort. Both thread and turn explicitly requested `approvalPolicy: never`; the thread requested read-only sandboxing and the turn supplied `sandboxPolicy: {type: readOnly}`. The native thread reported the selected model/provider, read-only permissions, and network access disabled.

The native agent called the synthetic tool exactly once. The wrapper matched the active thread and turn, tool name, namespace, and arguments, checked that the new call ID was a string, and recorded it with the request ID. It then returned a random receipt that was absent from the prompt. The assistant returned that receipt and the turn completed. There were no unexpected server requests or hook events. The adapter reported completed execution; the probe observed both owned process exits and confirmed their process groups no longer existed.

No worker was launched and the synthetic callback performed no filesystem, command, network, or external-service action. Native profile state remained harness-owned. The native response still listed the global instruction source, so this does not establish complete instruction/profile isolation.

## Earlier observation and limitations

The synthetic tool definition omitted the generated schema's required `type: function` discriminator. This installed executable accepted that minimal definition. The observation proves the native callback route with the stated launch controls, not conformance to the generated request schema. Production code must serialize the complete generated shape and verify it through the eventual end-to-end delegation acceptance.

An earlier standalone probe observed the same callback round trip but did not reuse the adapter's launch controls. It also logged native hook activity and recorded a termination signal without verifying process exit. Treat that observation as transport evidence only; it does not establish subscription-policy parity, absence of native side effects, or confirmed cleanup. The current-adapter observation above is the relevant compatibility prerequisite.

Production application-tool support still needs bounded schemas, exact session binding, cancellation and late-request rejection, durable idempotency, authorization, and scripted negative-route tests. A response containing a receipt is not proof that workers ran or that a plan was approved. The scheduler, presets, integration/check graph, and desktop approval cards remain unimplemented. Grok and Claude require their own native routes; Grok-only checks remain required. Owner-loss and detached descendants remain separate release requirements.
