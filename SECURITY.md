# Security

## Development status

Randolph is under active development. There is no stable security-supported release or long-term support branch yet. Fixes target the current development branch; older snapshots may remain unfixed. Public source availability is not a claim of production readiness.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** action in this repository's [Security tab](https://github.com/11-Mile-Labs/randolph/security), when available. If private reporting is unavailable, open an issue asking for a private reporting channel **without including vulnerability details or sensitive material**. Maintainers will arrange a private channel before requesting details. Do not post exploit details in a public issue or pull request before coordinating disclosure.

Include the affected commit/version, operating system and CLI version, a minimal reproduction using synthetic data, and the expected impact. Never include real credentials, customer data, or a copy of your application database. This small project does not promise a fixed response time or offer a bug bounty.

## Current trust boundaries

- Use live agents with projects and content you trust. Native Codex read-only and workspace-write policies constrain writes, but can permit reads outside the selected project. **Read-only does not mean private files elsewhere on your machine are inaccessible.** Tool output can enter the selected provider's model context even when child-command network access is disabled.
- Native harnesses use your existing local subscription login and may inherit profile behavior. Randolph does not provide complete isolation of profiles, instructions, credentials, or the whole host filesystem.
- Stop and application shutdown attempt to terminate owned native processes. Detached descendants and abrupt owner loss remain unresolved lifecycle limits; a process group alone is not proof that every descendant has stopped.
- Grok execution remains disabled while native tool and permission compatibility is verified. Experimental protocol code is not an enabled, supported execution route.
- Conversations, logs, lessons, and checkpoints may contain project content. They are retained in local application data, normally `~/.randolph`. Treat them as private and redact any excerpt before sharing it. Do not commit them to this repository.
- Native agents and enabled integrations communicate with their service providers. Consult those providers' data handling and subscription terms before supplying sensitive material.

See the [architecture](docs/architecture.md), [Codex compatibility evidence](docs/research/codex-0154-compatibility.md), [Grok compatibility evidence](docs/research/grok-adapter-2026-09-12.md), and [lifecycle findings](docs/research/lifecycle-completion-2026-09-12.md) for the current implementation limits.

## Security-sensitive contributions

Changes affecting execution permissions, approved revisions, path handling, IPC, process cleanup, or Git delivery need regression evidence for the relevant boundary. Preserve final user approval and separate push authorization. Never silence a failed capability check or replace it with a prompt asking the model to behave.
