# Project setup verification — 2026-09-12

## Scope

The project-setup increment adds explicit native inspection, editable context proposals, approval receipts, and frozen context for normal runs and checkpoint recovery. It does not complete the broader v1 context, delegation, workflow, or lifecycle requirements.

## Native inspection

One bounded inspection used installed Codex CLI 0.154.0, its existing ChatGPT subscription login, `gpt-5.6-luna`, and low reasoning effort on macOS arm64. The real runtime and Codex adapter inspected a synthetic non-Git project containing one README with a distinctive marker.

The turn completed before its deadline and returned a valid structured proposal that included the README marker. The proposal became available for review. The README remained byte-identical, no project configuration was created, and the project still contained only the README. Approval was not invoked in this native probe. Authentication remained CLI-owned; no credentials were extracted and no API execution fallback was used.

This proves that the tested native CLI can complete the bounded inspection path. It does not certify arbitrary project containment, every inherited tool, descendant shutdown, or another harness/version.

## Automated checks and review

The required lint, typecheck, build, and test commands passed. The test run comprised 160 runtime, 23 Codex adapter, 7 Grok adapter, and 22 desktop unit tests. The test process used an isolated Git global configuration so synthetic repositories did not depend on the developer's missing Git template directory; no user configuration was changed.

Regressions cover root replacement/redirection during native admission and before approval, rejection of generic chat dispatch into setup conversations, stale context/proposals, draft preservation, cancellation, frozen context across reopen/restart, legacy checkpoints, and an approval receipt failure after the YAML write succeeds. Electron fault injection uses a temporary SQLite trigger against the actual approval event rather than mocking the renderer bridge.

Independent review approved the setup implementation after these corrections. All nine Electron acceptance tests passed, covering chat replay, CLI selection, coding delivery, Grok gating, memory, navigation, project setup, recovery, and persistent workspace settings. The setup test covers both successful approval and actual receipt persistence failure. The receipt-failure view was directly inspected in captured top and lower viewport images.

The chat replay acceptance test intermittently stalled in Playwright's mouse click after Electron relaunch, despite a visible, focused window and responsive animation frames. No transport failure was observed before that click. The replay assertion now uses focused keyboard activation, with existing mouse-navigation checks retained earlier in the same test. Three sequential repetitions passed, and independent review accepted the unchanged replay/no-new-execution requirements. This does not establish that the intermittent automation mouse-click stall is fixed.

## Cleanup limits

New executions record a hashed Mac identity and boot-session identifier. Synthetic tests verify that explicit reconciliation requires a later boot on the original Mac and cannot clear active, same-boot, copied-machine, legacy, malformed, or unavailable evidence. Failed persistence preserves quarantine. Reconciliation leaves the original run interrupted and starts no work.

The origin provider was available on the test Mac, but no physical reboot experiment was performed for this increment. This limited recovery path does not resolve the existing owner-loss and detached-descendant release gaps. Grok execution remains disabled because its earlier native filesystem boundary probe failed.
