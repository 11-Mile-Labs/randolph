# Safety sandbox comparison

**Checked:** 2026-09-12. Official documentation and public source inspection only; no installation, sandbox execution, account access, or performance measurement. This report follows the [scope correction](sandbox-scope-2026-09-12.md): sandboxing work for safety is an optional later feature. It does not select Randolph's execution architecture or address Stop/recovery.

## Finding

There is no universal requirement to use a VM for agent safety. The products reviewed use different boundaries: native operating-system restrictions, containers for selected tools, or an optional wrapper around the whole agent. Their defaults and exposed tools differ substantially. A product saying it supports sandboxing does not establish that a particular session is protected.

## Native harnesses

| Harness     | Documented approach                                                                                                                                    | Boundary and limits relevant to Randolph                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex local | macOS Seatbelt; Linux bubblewrap plus seccomp. Local restricted execution does not require a guest OS.                                                 | Permission profiles govern sandboxed local commands. MCP, connectors, browser/computer use and service traffic have separate controls; an approved escalation can leave the command sandbox. Select and verify the actual profile.                                                                   |
| Claude Code | Optional Bash sandbox uses Seatbelt on macOS and bubblewrap on Linux, with network proxies. macOS requires no additional sandbox runtime installation. | Bash and child commands are covered; ordinary subagents reuse the parent's sandbox configuration. This does not sandbox every tool. Unsandboxed retries, excluded commands and unavailable-sandbox fallback need explicit handling.                                                                  |
| Grok Build  | Opt-in process-wide filesystem sandbox; Seatbelt on macOS, Landlock plus additional Linux mechanisms as needed. Default is off.                        | In-process file tools and child filesystem access are covered. Its documented child-network restriction is a no-op on macOS. The workspace profile permits broad reads; strict still reads Grok's own home. Built-in profile failures may warn and continue; custom-profile failures refuse startup. |

Sources: [Codex OS enforcement](https://learn.chatgpt.com/docs/agent-approvals-security), [Codex permission scope](https://learn.chatgpt.com/docs/permissions), [Claude sandbox configuration and scope](https://code.claude.com/docs/en/sandboxing), [Grok sandbox guide at commit 3794978](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md).

Claude exposes `failIfUnavailable: true` and `allowUnsandboxedCommands: false`; `excludedCommands` remains a separate exception path. Its sandboxed commands normally retain broad read access unless restricted. These details mean that enabling the feature alone is insufficient to assert credential isolation. Codex similarly separates approval policy from the command's enforced access profile. None of these documented capabilities establishes the configuration of the user's currently installed harnesses; that requires a later version-specific check.

## Hermes Agent

Hermes defaults to a local terminal backend with the host user's access. Docker is optional, with capability drops, no-new-privileges and resource controls. Docker networking is enabled by default and can be disabled. Host mounts and forwarded environment variables deliberately grant additional access. Its documented default container is shared across sessions and process invocations within the profile; per-session isolation is available with `container_persistent: false`, while delegated subagents still share their parent's environment. [Pinned configuration](https://github.com/NousResearch/hermes-agent/blob/04dd80a977f40b05e5b2054111747af07a61886a/website/docs/user-guide/configuration.md#docker-backend).

The terminal backend covers shell/file operations routed through it. Hermes separately documents whole-agent wrapping for a broader boundary because plugins, hooks and agent-side components retain host privileges. Environment filtering reduces exposure but cannot isolate code running in the agent's own process. [Pinned security model](https://github.com/NousResearch/hermes-agent/blob/04dd80a977f40b05e5b2054111747af07a61886a/SECURITY.md#22-the-boundary-os-level-isolation).

**Documentation discrepancy resolved against code:** at this same commit the security policy describes `execute_code` as a host subprocess, while the Docker configuration says it runs in the container. The implementation dispatches non-local backends through `_execute_remote`; Docker therefore includes this operation. The local path remains host-side. Its `strict` mode changes working directory/interpreter selection and is not an OS sandbox. [Execution dispatch](https://github.com/NousResearch/hermes-agent/blob/04dd80a977f40b05e5b2054111747af07a61886a/tools/code_execution_tool.py#L718-L729).

## OpenClaw

OpenClaw's default agent sandbox mode is off. When enabled, Docker is the default backend and agent is the default sharing scope; session and shared scopes are also available. A creator role can require sandboxing regardless of agent mode, with stronger restrictions on escape and sharing. This is more precise than a single global sandbox toggle. [Modes and scope](https://docs.openclaw.ai/gateway/sandboxing/modes-scope-and-backend).

Its default sandbox workspace access is `none`: tools work in a separate writable sandbox workspace without exposing the agent workspace. `ro` exposes the agent workspace read-only and `rw` permits direct writes. Skills can be materialized as read-only instruction roots. Remote SSH shell restrictions depend on the remote policy; setting a workspace label alone does not enforce them. [Workspace access](https://docs.openclaw.ai/gateway/sandboxing/workspace-access).

The Gateway itself is outside the tool sandbox. Tool policy determines which tools are available, while sandbox configuration determines where covered tools execute. Elevated execution is a separately controlled host path, not additional isolation. Role-required sandboxes prohibit that bypass. [Sandbox overview](https://docs.openclaw.ai/gateway/sandboxing), [sandbox versus tool policy and elevated execution](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated).

The release source inspected at commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107` constructs Docker execution with a read-only root, temporary writable mounts, dropped capabilities and no-new-privileges. Its default network is `none`. Explicit environment configuration can inject credentials; bind mounts can expose host data. These are operator-controlled holes, not a guarantee that secrets are undiscoverable. [Defaults](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/agents/sandbox/config.ts#L101-L125), [Docker arguments](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/agents/sandbox/docker.ts#L321-L399). The live documentation may describe changes beyond that pinned release.

## Setup and cost

Native macOS restrictions avoid downloading and booting Linux. That is an architectural difference, not a measured zero-overhead claim. Compatibility still depends on the exact filesystem, network, IPC and credential rules a tool needs.

Hermes/OpenClaw container options require a container engine and images. Docker Desktop runs Linux containers inside its Linux VM on macOS. Therefore, choosing Docker does not eliminate virtualization overhead; it delegates that infrastructure to Docker. This report contains no comparable idle-memory or startup benchmarks and makes no numerical performance ranking. [Docker Desktop VMM documentation](https://docs.docker.com/desktop/features/vmm/).

Remote/cloud backends introduce another machine or service and may incur separate charges. Their availability in another product does not establish compatibility with Randolph's subscription-only requirement. No paid backend is proposed here.

## Reusable implementation worth investigating

Anthropic publishes an Apache-2.0 standalone Sandbox Runtime as a CLI and library. It can wrap commands or local MCP servers using native restrictions and a network proxy, without a container. It remains a research preview. Read access is broad by default unless restricted, and allowing powerful sockets or Apple Events can undermine the intended boundary. It is a candidate for a bounded compatibility investigation, not an approved dependency or proof that every harness can be wrapped safely. [Sandbox Runtime](https://github.com/anthropics/sandbox-runtime/tree/c392e6cf9f8df957c66d9ab1461e2cfa99b1ab5d).

## Recommendation for discussion

Start from the required safety policy, then compare the lightest mechanisms that can enforce it. Preserve each harness's native protections and expose their actual scope. Evaluate optional stronger isolation for work that needs it; a container or micro-VM is one possible safety implementation, not a prerequisite for Randolph.

Hermes/OpenClaw route tools they control into their chosen backend. Randolph driving another vendor's CLI cannot assume that it can redirect every built-in tool in the same way. Native harness restrictions, an external wrapper and an isolated tool backend are distinct integration options; compatibility must be established before choosing one. This is the main architectural inference from the comparison, not a claim that subscription authentication has been verified under any new sandbox.

OpenClaw provides a concrete example for our integration research: its current Docker documentation says an active sandbox disables Codex App Server's native Code Mode, user MCP servers and app-backed plugins by default, then routes shell operations through sandbox-backed tools. An experimental exec-server path is available under additional conditions. This supports investigating host-side harness authentication with separately isolated tool work, but exposes a feature-compatibility tradeoff that Randolph must evaluate rather than hide. [OpenClaw's Codex sandbox integration](https://docs.openclaw.ai/gateway/sandboxing/docker-backend).

For a future sandbox feature, proposed review criteria are:

1. Specify allowed file reads/writes, network destinations, credential access and local service/socket access.
2. Name the protected tools and identify host-side exceptions, including MCP, hooks and plugins.
3. Make isolation from sibling work explicit; shared containers are not independent workspaces merely because sessions have different names.
4. Refuse or request an explicit policy change when required protection is unavailable. Never silently relabel a weaker mode as equivalent.
5. Test the selected harness and policy with synthetic denied reads/writes/network requests before claiming compatibility; measure setup and runtime costs only for viable candidates.

These are proposals for the later safety feature, not newly approved v1 requirements. Worktree isolation and final commit/merge/push approvals remain the previously agreed independent controls. Stop and lifecycle work remain outside this report.
