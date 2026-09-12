# Controlled-run experiment

A bounded, headless Codex experiment. This is research code, not the Randolph application or a production security boundary. The [initial result](../../docs/research/controlled-run-2026-09-12.md) was unverified; subsequent probes established [Git enforcement](../../docs/research/scripted-git-2026-09-12.md) and [partial lifecycle evidence](../../docs/research/lifecycle-2026-09-12.md). Checkpoints and delivery remain unimplemented.

## Offline checks

Requires macOS for native execution, Git, Node 24 or newer, and pnpm. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Default tests use synthetic local repositories and processes. They make no model calls. Approval tests validate predicates only; no commit/merge delivery engine is implemented.

## Explicit native execution

Requires an installed `codex` CLI authenticated with its own ChatGPT subscription. The harness-owned authentication stays in place. Execution inherits an allowlisted environment, disables configured MCP servers and optional tools for this probe, and records version/schema metadata. API authentication and unavailable model/effort selections stop the run.

Choose new absolute directories outside existing repositories and outside each other. The fixture must be outside OS temporary roots. The evidence directory must not already exist. For example:

```sh
pnpm test:native --readiness \
  --data-dir "$HOME/.randolph/experiments/your-unique-readiness-id" \
  --fixture-root "$HOME/.randolph/fixtures/your-unique-readiness-id"
```

`--readiness` makes no model turns. Native inference instead requires `--run`, an explicit available `--model`, and `--effort`:

```sh
pnpm test:native --run --model gpt-5.6-luna --effort low \
  --data-dir "$HOME/.randolph/experiments/your-unique-run-id" \
  --fixture-root "$HOME/.randolph/fixtures/your-unique-run-id"
```

These examples are manual opt-ins, not instructions to rerun the completed experiment. The effective-policy guard accepts the version-pinned Codex 0.149.0 empty additional-root representation only when the canonical cwd and runtime roots match the fixture. Known global instructions remain active and are inventoried; unexpected or changed sources are rejected. No automatic model substitution or inference retry exists.

One `--corrected` invocation is permitted only for an inconclusive native protection attempt, reusing its sealed evidence directory and remaining budget with a newly created fixture at the original path. A readiness-only result is not eligible. An unsealed, altered or legacy evidence directory is refused. Eight model turns and 900,000 ms of conservative reservations are the cumulative ceilings; each turn is bounded to 60 seconds. Exhaustion requires a separate decision, not a fresh directory to evade the limit.

## Evidence and cleanup

`events.jsonl` stores ordered, flushed records; `results.json` is a readable projection. Native command metadata and digests are retained, while raw tool output and reasoning are omitted. The versioned schema and, when reached, the useful-change diff remain in the private evidence directory. Do not publish the entire directory without reviewing it.

Routine completion terminates the App Server process group and removes only the process-owned fixture. No checkpoint or resume is implemented. Process-group cleanup does not prove owner-loss or detached-descendant containment. If the controller is killed, inspect owned process/fixture state manually; do not infer that reopening terminates or resumes anything.

The journal supports single-controller use. Directory ownership checks catch accidental reuse, path substitution and changed evidence; they are not protection against a malicious process with the same OS identity racing filesystem operations. Never run concurrent controllers against one evidence directory.

## Focused permission follow-up

The operator-authorized [follow-up](../../docs/research/permission-followup-2026-09-12.md) used its complete three-turn budget and ended unverified. It has a separate explicit entrypoint:

```sh
pnpm test:followup --run --model gpt-5.6-luna --effort low \
  --data-dir "$HOME/.randolph/experiments/your-new-followup-id" \
  --fixture-root "$HOME/.randolph/fixtures/your-new-followup-id"
```

Use `--readiness` instead of `--run` for a no-inference preflight. Both require an explicit model/effort and new directories. This runner never reopens an evidence directory or retries a native turn. New directories do not authorize exceeding an agreed experiment budget. The third turn checks work after a denied request; it is not a retry of the unexecuted Git case. Controlled prompts, including private fixture paths, are stored in the private journal for traceability. Review and sanitize retained material before sharing it.

## Deterministic native Git proof

The [approved Git enforcement test](../../docs/research/scripted-git-2026-09-12.md) passed on Codex 0.149.0. It uses the real installed App Server, native shell tool, Git and sandbox, with a loopback server supplying scripted model responses. It makes no paid model calls and requires no credentials.

```sh
pnpm test:scripted --run \
  --data-dir "$HOME/.randolph/experiments/your-new-scripted-id" \
  --fixture-root "$HOME/.randolph/fixtures/your-new-scripted-id"
```

Both directories must be new and satisfy the existing fixture constraints. The script uses a fresh Codex home outside the writable worktree. It runs four bounded cases: ordinary write, denied direct commit, declined commit approval, and the exact commit explicitly permitted once as the positive control. Only disposable fixture refs may change. It does not merge or push. Each scripted native turn remains bounded to 60 seconds; the provider never retries or falls back to a live service. Scripted turns are recorded separately from model inference reservations.

Private evidence includes exact commands, cwd, call IDs, actual tool outputs and refs. Do not publish these files wholesale. Routine cleanup removes the fixture and isolated home and closes the native process group and loopback server. This is not a crash-recovery guarantee.

## Lifecycle probe

The [completed experiment](../../docs/research/lifecycle-completion-2026-09-12.md) failed detached-child containment. This supervisor's `stopped` projection describes only its observed set and cannot certify all work exited. It is research code, not a production lifecycle implementation.

`pnpm test:lifecycle --run --data-dir "$HOME/.randolph/experiments/<unique-lifecycle-run>" --fixture-root "$HOME/.randolph/fixtures/<unique-lifecycle-run>"` opts into four bounded native cases: Stop, controller SIGKILL, harness SIGKILL and a rapidly detached child. Both directories must be absolute and new. The installed Codex 0.149.0 App Server uses only local scripted Responses fixtures with a new credential-free home; no inference calls or subscription credentials are needed.

The candidate is a per-run supervisor connected to the controller by IPC. It closes dispatch on Stop or controller loss, requests native cancellation, allows two seconds for graceful shutdown, then terminates observed descendants using PID, UID and microsecond start identities. The target is five seconds from the observed fault to the termination result. macOS `libproc` supplies identities through a small C helper built with `clang` in active OS scratch space. Default offline tests compile and exercise this helper on macOS; other platforms skip its native test. No system service is installed.

Polling cannot guarantee observation of a child that reparents between snapshots. The synthetic detached case deliberately tests this gap without cooperative registration. The independent observer verifies active native tools, watches heartbeat/canary writes, checks an unrelated sentinel, and records failures before watchdog rescue. The candidate never reads fixture PID receipts. Each journal has one writer; a separate process reopens retained state without dispatch. This does not implement checkpoint restoration or Restart.

Helper binaries are volatile scratch; logs/results remain outside the repository. Fixture removal requires observed cleanup. A failed boundary ends the probe and remains failed after rescue. Supervisor loss, atomic PID-bound signaling, arbitrary process containment and Electron failure modes require separate designs or evidence.
