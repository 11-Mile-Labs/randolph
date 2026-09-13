# Contributing to Randolph

Thanks for helping build Randolph. This is an early, actively developed macOS application: incomplete features, rough edges, and changes to internal interfaces are expected. Useful bug reports, documentation, accessibility improvements, and focused code changes are welcome.

## Start here

Read the [README](README.md) for what currently works, the [roadmap](docs/roadmap.md) for direction, and the [architecture](docs/architecture.md) when changing behavior across packages. The [product specification](docs/product-spec.md) describes the intended v1, not a claim that everything is implemented.

Search existing [issues](https://github.com/11-Mile-Labs/randolph/issues) before opening one. For a substantial feature or architecture change, describe the problem in an issue before investing in an implementation. Small fixes can go straight to a pull request. Report vulnerabilities through the [security policy](SECURITY.md), not a public bug report.

## Set up development

Use macOS, Git, Node 24.18, and pnpm 11.8.0. The manifests pin these development versions. An installed Codex CLI signed into ChatGPT is needed for live conversations; automated tests use fixtures and do not require a subscription or API key.

Base your branch and pull request on `main`.

```sh
git clone https://github.com/11-Mile-Labs/randolph.git
cd randolph
pnpm install --frozen-lockfile
git switch -c feature/your-change
pnpm build
pnpm desktop
```

For contributions, push to your fork and open a pull request against `main`. Keep test projects separate from important working repositories. To use disposable application state, launch with `RANDOLPH_DATA_DIR` pointing to a new directory outside your checkout. See [security and trust limits](SECURITY.md) before using live agents.

## Find the code

| Location | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main/preload, React interface, desktop acceptance tests |
| `packages/runtime` | State, project settings, approvals, execution, recovery, and Git delivery |
| `packages/harness-codex` | Native Codex subscription adapter |
| `packages/harness-grok` | Grok discovery and experimental protocol work; execution is gated |
| `docs` | Product direction, decisions, plans, and compatibility evidence |
| `experiments` | Isolated research; not a production capability guarantee |

Use TypeScript/ES modules, two-space indentation, semicolons, and async/await. Prefer small changes with clear names. Keep private integrations and operator-specific settings out of the public core.

## Verify a change

For application code, run the repository checks:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

After building, run `pnpm test:desktop` for UI or IPC changes on macOS. Exercise affected workflows manually when that reveals something automated tests cannot. Documentation-only changes need accurate instructions, valid links, and clean formatting rather than a new test suite.

GitHub Actions runs these checks, desktop acceptance tests, and the isolated experiment's lint, typecheck, and fixture tests on a standard macOS runner. It uses a read-only token and does not upload artifacts or caches. Workflows from outside contributors require maintainer approval. Dependabot opens weekly dependency update pull requests; updates still need passing checks and maintainer review.

Tests should verify meaningful behavior, especially stale approvals, cancellation, recovery, and permission boundaries. Native compatibility claims require evidence from the actual pinned CLI; a scripted adapter passing a test does not establish native enforcement. Do not run live model, fault-injection, or experiment commands against someone else's projects or credentials.

Explain what passed, what failed, and what you did not run in your pull request. A known limitation is useful information; do not hide it or label an untested route supported. Draft pull requests are welcome.

## Submit a pull request

Describe the problem, resulting behavior, and relevant verification. Include screenshots for visible UI changes when useful. Keep unrelated refactors and dependency updates separate so reviewers can assess the change. Maintainers decide when changes are ready to merge; an open pull request does not imply a response-time guarantee.

AI-assisted contributions are welcome. You remain responsible for understanding the code, checking it, and having permission to contribute it. Mention material AI assistance when it helps reviewers understand the work; do not submit generated output you cannot explain.

Never attach raw `~/.randolph` data, complete agent transcripts, auth files, environment files, or credentials. Share a minimal reproduction and redact project/customer details from logs and screenshots.

Contributions are made under the [project license](LICENSE). Retain attribution and license notices for third-party material, and submit only work you have the right to share. Please follow the [code of conduct](CODE_OF_CONDUCT.md).
