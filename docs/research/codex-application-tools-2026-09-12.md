# Codex application-tool compatibility

Evidence date: 2026-09-12. Status: bounded native callback proof passed for installed `codex-cli 0.154.0`. This is a prerequisite for application-owned delegation, not an implemented delegation feature or a complete lifecycle proof.

## Interface

Version-generated schemas expose `thread/start.dynamicTools`, the server-originated `item/tool/call` request, and a response with `success` and `contentItems`. The callback carries native thread, turn, call, namespace, and tool identities plus arguments. The response uses the original JSON-RPC request ID. Initialization enables the experimental API.

## Native observation with current adapter controls

The compiled `CodexAdapter.discover` and `CodexAdapter.run` now pass a bounded native proof through the adapter's application-tool interface, without a transport wrapper or injected protocol fields. The production serializer supplies the complete `{type: function, name, description, inputSchema}` definition. The synthetic callback returns a harmless receipt and exercises the adapter's normal process launch, environment, subscription check, permissions, interruption, and process-group cleanup.

Discovery confirmed the installed version, ChatGPT authentication, and availability of `gpt-5.6-luna` with low effort. The run selected that model and requested low effort. Both thread and turn explicitly requested `approvalPolicy: never`; the thread requested read-only sandboxing and the turn supplied `sandboxPolicy: {type: readOnly}`. The native thread reported the selected model/provider, read-only permissions, and network access disabled.

The native agent called `randolph_read_tasks` exactly once. The adapter bound the callback to the active thread and turn, validated the tool name, null namespace, call identity, and bounded arguments, and answered original JSON-RPC request ID `0`. It returned a random receipt absent from the prompt. The assistant acknowledged that receipt and the turn completed. No command, file, or approval action was recorded. Both owned processes exited with SIGTERM and their process groups no longer existed. The synthetic workspace still contained only its unchanged README.

No worker was launched and the synthetic callback performed no filesystem, command, network, or external-service action. Native profile state remained harness-owned. The native response still listed the global instruction source, so this does not establish complete instruction/profile isolation.

## Earlier observation and limitations

An earlier transport-wrapper proof omitted the generated schema's required `type: function` discriminator. The installed executable accepted that minimal definition, but the observation did not establish schema conformance. The current production-adapter proof above supersedes that limitation by using the complete generated shape.

An earlier standalone probe observed the same callback round trip but did not reuse the adapter's launch controls. It also logged native hook activity and recorded a termination signal without verifying process exit. Treat that observation as transport evidence only; it does not establish subscription-policy parity, absence of native side effects, or confirmed cleanup. The current-adapter observation above is the relevant compatibility prerequisite.

Scripted adapter tests cover bounded schemas, exact session binding, pre-acknowledgment requests, cancellation and late-request rejection, response bounds, original request ID preservation, and continued denial of native command/file/permission approvals. The adapter advertises application-tool compatibility only for the verified installed version. Durable broker receipts and authorization require their separate runtime tests and review; the normal main-agent dispatch does not yet enable these tools.

A response containing a receipt is not proof that workers ran or that a plan was approved. The scheduler, presets, integration/check graph, and desktop approval cards remain unimplemented. Grok and Claude require their own native routes; Grok-only checks remain required. Owner-loss and detached descendants remain separate release requirements.
