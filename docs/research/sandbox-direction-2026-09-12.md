# Sandbox containment direction

**Research status:** superseded by the [user's scope correction](sandbox-scope-2026-09-12.md). The VM recommendation below incorrectly expanded safety sandboxing into general lifecycle control and is withdrawn. Technical comparisons are historical research; proposed actions below are inactive.

**Checked:** 2026-09-12 against official vendor documentation and the local macOS SDK. No harness login, credential transfer, software installation, model inference, or service change was performed.

Randolph's process-lifecycle experiment showed the limit of host process-tree polling: a child can create a new session and reparent before the observer records its identity. A stronger Stop guarantee requires a containment boundary whose lifetime does not depend on discovering every guest process.

## Recommendation

**Follow-up:** the user challenged the proposed Ubuntu/Lima footprint. That installation is now parked; continue the [lightweight sandbox investigation](lightweight-sandbox-2026-09-12.md). The comparison below remains research context, not a selected runtime.

Use a Linux virtual machine as the next research boundary. Prototype the contract with Lima using Apple's Virtualization framework, then evaluate direct integration with Apple's Containerization package if the product can require macOS 26 on Apple silicon.

This recommendation depends on a separate authentication proof. A host-side agent CLI remains outside the guest boundary, so its shell descendants are not contained by the VM. Strong containment requires the native harness or App Server to run inside the guest. Each supported harness must authenticate interactively into a guest-owned credential store; Randolph must not copy or mount the host's credentials, Keychain, SSH agent, or home directory.

## Candidate comparison

| Candidate | Boundary and lifecycle | Dependencies and license | Fit | Material limits |
| --- | --- | --- | --- | --- |
| **Lima with VZ** | A Linux VM provides one kernel boundary for the run. Lima uses Apple's Virtualization framework by default on supported macOS systems. | Apache-2.0; installable independently. VZ is supported on macOS 13 or newer. | **Best feasibility probe.** It can run with mounts disabled and execute guest commands through `limactl`. | It is an external runtime, not the final app-owned implementation. Guest authentication and VMM owner-loss behavior still need proof. |
| **Apple Containerization package** | Each Linux container runs in its own lightweight VM. Its guest init exposes process launch, I/O, signals, and events. | Apache-2.0; direct Swift integration uses Virtualization.framework. The current package requires Apple silicon, macOS 26, and Xcode 26 to build. | **Strongest product candidate** if that platform floor is acceptable. Direct integration can keep VM ownership in an app-controlled native component. | Adds Swift, image, kernel, root-filesystem, and native packaging work. Source compatibility is intentionally limited while the project is young. |
| **Apple `container` CLI** | Uses the same per-container lightweight VM architecture. | Apache-2.0; current supported platform is macOS 26 on Apple silicon. The signed installer writes under `/usr/local`, requires administrator approval, and starts a system service. | Useful as a disposable research driver. | Its installed service conflicts with Randolph's current no-standalone-daemon posture. It should not be treated as equivalent to direct package integration. |
| **Direct macOS VM** | A full macOS guest through Virtualization.framework contains all guest processes and preserves native macOS CLI behavior. | Apple framework and virtualization entitlement; macOS restore image, installation, storage, updates, and guest licensing apply. Apple-silicon macOS guests require Apple silicon. | Compatibility fallback if a required subscription CLI cannot operate in Linux. | Much heavier than a Linux guest. A guest still needs its own interactive login; host Keychain reuse is outside the safe design. |
| **Colima** | Runs container runtimes over Lima. | MIT. Adds a container-runtime layer over Lima. | No advantage for the first direct VM/harness proof. | More lifecycle and configuration machinery than this experiment needs. |
| **OrbStack** | Linux machines and containers share one Linux VM and kernel. Isolated machines remove default host mounts and integrations. | Proprietary. Personal use is free; business and commercial use require a paid plan. | Convenient local comparison only. | OrbStack states that isolated machines are not a full security boundary against active kernel escape. It is also a commercial product dependency for Randolph. |
| **Endpoint Security** | Reports process fork and exec events with audit-token process identities. | Requires Apple's Endpoint Security entitlement, root execution, user approval, and a packaged system extension. | Could improve host lineage observation and identity-safe signaling. | It observes or authorizes host events rather than supplying a VM boundary. It creates a privileged, long-lived component and a new failure domain, contrary to the v1 posture. |

Apple's current `container` documentation is easy to misread. The maintained CLI and Containerization package declare macOS 26 as their supported baseline. The technical overview says the CLI can run on macOS 15 with limitations, while also saying maintainers do not plan to address macOS 15 issues that cannot be reproduced on macOS 26. That is compatibility, not support. The machine used for this research is macOS 26.6.2 on arm64 Apple M2 Ultra, so it meets the documented platform requirement; no installation was attempted.

## Harness and subscription compatibility

CLI availability does not prove that Randolph can drive the harness programmatically in a guest. Authentication, headless protocol support, permission callbacks, cancellation, and event fidelity are separate checks.

| Harness | Official Linux availability | Official subscription login suitable for a headless guest | Programmatic surface relevant to Randolph | Current conclusion |
| --- | --- | --- | --- | --- |
| **Codex** | The CLI has an official shell installer and Linux documentation. | `codex login --device-auth` is the preferred beta flow when a remote or headless environment cannot receive the localhost OAuth callback. It shows a URL and one-time code. Workspace or personal security settings must allow device-code login. | App Server directly supports `account/login/start` with `chatgptDeviceCode`, returning `verificationUrl`, `userCode`, and completion/account notifications. Browser login instead hosts a callback on guest localhost. | **Best-supported guest path on paper.** Device-code login can stay guest-local without copying cached credentials. It still needs a no-inference guest proof using the exact installed App Server version. |
| **Claude Code** | Anthropic supports Ubuntu 20.04+/Debian 10+ and provides npm and native Linux installation methods. | Claude Code supports Claude App Pro/Max login through the startup OAuth flow. The reviewed official pages describe completing OAuth and browser login but do not document a device-code option or the callback/redirect behavior for a remote Linux guest. | The CLI supports noninteractive streaming JSON and a permission-prompt MCP tool. This research did not find an App-Server-equivalent account API in the reviewed official documentation. | **CLI availability confirmed; headless subscription ceremony unverified.** A harmless guest login-flow inspection must determine whether it prints a transferable URL/code or needs browser/port forwarding. |
| **Grok Build** | xAI publishes prebuilt macOS, Linux, and Windows binaries; its installer supports macOS and Linux. | `grok login --device-auth` is documented for SSH sessions, containers, and headless hosts. It prints a URL and short code for completion in another browser. Browser login stores renewable credentials in the guest's `~/.grok/auth.json`. | Grok documents headless execution and ACP embedding. The reviewed sources do not establish that ACP exposes authentication orchestration equivalent to Codex App Server. | **Guest CLI login is supported on paper; ACP auth integration remains unverified.** Keep the guest credential home private and persistent only under an explicit lifecycle design. |

Do not use the vendors' documented credential-copy fallbacks for this proof. They may be valid for trusted personal machines, but copying a host auth cache into an execution sandbox expands the sandbox's secret authority and obscures credential ownership.

## Filesystem and Git boundary

Do not mount the host home or the whole parent repository writable. A linked Git worktree contains a `.git` file that points into shared metadata under the parent repository. Mounting only the worktree omits metadata the CLI may need; mounting the repository exposes protected refs and worktree indexes that Randolph intends to reserve for reviewed finalization.

The safer candidate is:

1. Build a guest-local repository from an app-created bundle or content snapshot.
2. Give the guest no real remote credentials and no host Git metadata.
3. Keep the guest disk or per-run volume inside Randolph's owned run storage.
4. Export a complete, checksummed content snapshot and evidence to the host.
5. Let the host runtime compare that export to the approved basis and perform commit, merge, and push through its separate approval gates.

Lima supports `--plain` mode with mounts and port forwarding disabled, plus explicit narrow mounts when needed. Apple Containerization lets the client mount only selected host data into each VM. Writable shared folders should be treated as an optimization to evaluate after the guest-disk flow, not as the initial security boundary.

## Stop and owner-loss semantics

Stopping the VM terminates execution of every process in its guest kernel, including reparented and detached descendants. This is the property the polling candidate lacks. Apple's API distinguishes graceful `requestStop` from forced `stop`.

Two claims still require fault injection:

- Official documentation exposes VM stop controls but does not promise that killing Randolph's host process automatically stops every VM. An independent per-run supervisor should own the VMM identity, detect app IPC loss, and force-stop the VM.
- Forced VM stop can interrupt guest-disk and shared-filesystem writes. Randolph should report work after the last durable host checkpoint as uncertain, verify the guest filesystem before reuse, and restore from a known checkpoint rather than calling an abrupt stop a clean save.

The proof must test explicit Stop, controller death, supervisor death, VMM death, a deliberately detached guest process, delayed mutation absence, and checkpoint recovery. It must separately observe that the guest is no longer executing and that exported state is durable.

## Why host audit sessions do not close the gap

The local macOS SDK states that `EVFILT_PROC` can report `NOTE_FORK`, but the child PID is not delivered in the actual event. The same header states that automatic `NOTE_TRACK` and `NOTE_CHILD` support ended in macOS 10.5. A fork notification followed by process enumeration narrows the race but does not eliminate it.

Creating a unique audit session requires privilege, and the public audit-session device reports session start, update, end, and close events rather than a complete process-membership list. A unique operating-system user would make UID enumeration more selective, but creating and maintaining per-run accounts is privileged, persistent machine mutation and complicates subscription credentials. Neither is the smallest honest v1 route.

Audit tokens are still useful for atomically signaling a process whose token is already known. They do not discover a child that escaped before observation.

## Next safe proof

The host command search found no installed `limactl`, `container`, `colima`, or `orb` executable on its current PATH. This is an executable-discovery result, not a full application inventory. No VM or supporting runtime was installed or launched during this research.

Run no model inference and mount no repository for the first VM experiment.

1. Confirm Lima/VZ can create a no-mount guest and that killing its VMM stops a synthetic detached process and delayed canary.
2. Install nothing until the operator separately authorizes it. Record exact packages, services, disk use, and cleanup before installation.
3. Inside a disposable guest, inspect `--version`, login help, and protocol help for one harness at a time.
4. For Codex and Grok, start the documented device-code ceremony, record only the flow shape, and cancel before authentication unless the operator explicitly authorizes completing login.
5. For Claude, determine whether the subscription OAuth ceremony supports a headless URL/code, a forwarded localhost callback, or neither. Preserve this as unknown until observed.
6. Only after a guest-owned subscription login succeeds, run a zero-effect account/status check through the exact App Server or ACP surface. Do not infer protocol authentication from an interactive CLI session.
7. Then repeat the scripted detached-child lifecycle fixture in the guest and fault the controller, supervisor, and VMM independently.

## Primary sources

- Apple: [Virtualization framework](https://developer.apple.com/documentation/virtualization), [`VZVirtualMachine` lifecycle](https://developer.apple.com/documentation/virtualization/vzvirtualmachine), [Containerization package](https://github.com/apple/containerization/blob/main/README.md), [`container` CLI](https://github.com/apple/container), [`container` technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md), [Endpoint Security](https://developer.apple.com/documentation/EndpointSecurity), [Endpoint Security entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.endpoint-security.client).
- Lima and alternatives: [Lima VM types](https://lima-vm.io/docs/config/vmtype/), [filesystem mounts](https://lima-vm.io/docs/config/mount/), [usage](https://lima-vm.io/docs/usage/), [Lima license](https://github.com/lima-vm/lima/blob/master/LICENSE), [Colima](https://github.com/abiosoft/colima), [OrbStack isolation model](https://docs.orbstack.dev/machines/isolated), [OrbStack architecture](https://docs.orbstack.dev/architecture), [OrbStack pricing](https://orbstack.dev/pricing).
- Harnesses: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex App Server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints), [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Grok Build repository](https://github.com/xai-org/grok-build), [Grok authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md), [Grok enterprise deployment](https://docs.x.ai/build/enterprise).
