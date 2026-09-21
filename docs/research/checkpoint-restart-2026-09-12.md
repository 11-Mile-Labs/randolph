# Durable checkpoint and explicit restart

**Passed for the bounded experiment.** A self-contained checkpoint restored the completed fixture after its entire source repository and local remote were removed. A fresh subscription-backed Codex session then ran the restored tests and recalled the retained decision. Reopening alone dispatched no native work.

## Observations

Recorded on 2026-09-12 UTC with Codex CLI 0.149.0, Node 24.18.0 and macOS arm64. The explicitly selected model was `gpt-5.6-luna` at low effort, using ChatGPT subscription authentication. The final verification used one native model turn. An earlier successful fixture observation also used one turn, for two across both probes; no API billing fallback or model substitution occurred.

| Check                   | Result                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Delete source           | Entire original fixture repository, worktree and local bare remote removed before restore                                      |
| Reopen retained history | Displayed `stopped`; no restored directory, native session or model turn created                                               |
| Restore Git and files   | Original base commit, completed bugfix, binary artifact and executable mode restored; ignored scratch absent                   |
| Restore context         | Configuration, decisions, completed/pending work and external-action metadata matched the checkpoint                           |
| Explicit native Restart | Created a new linked run in the same conversation and a clean native thread                                                    |
| Native verification     | Executed `node --test test/filter.test.mjs`; both regression tests passed; saved decision marker recalled                      |
| History and late events | Original journal unchanged; old-run completion event rejected; reopening an already-used restart journal cannot dispatch again |
| Cleanup                 | Owned native process group exited; original and restored fixtures absent; durable checkpoint and evidence retained             |

The source bugfix was seeded by the experiment controller as completed synthetic work. This proves persistence and subsequent native verification, not that the restarted model authored the original change.

## Persistence contract

The checkpoint stores checksummed file blobs, file modes, symlink targets, deletions, an immutable base commit identity, a Git bundle and retained context in a manifest. Identical bytes share a blob. Capture requires quiescent writers and compares the source inventory before publishing; an observed source change aborts capture.

Content, bundle and relevant directories are flushed before the manifest is made recoverable through the single append-only source journal. An independent object database proves the bundle contains the requested base commit before publication. A manifest file alone is insufficient. Verification requires the journal's exact manifest digest, valid paths/schema and matching content/bundle checksums. Multiply linked source files are rejected.

Restore verifies the complete checkpoint before creating a new repository. It uses the bundled base object, clears checkout content without following symlinks, and applies the full saved content before verifying the restored inventory. Source, storage and destination parent symlinks are rejected. A stored symlink is reproduced as a link; its target is not imported. Executable permissions are retained; privileged mode bits, extended attributes, ACLs, submodules, filesystem snapshots and Git LFS object hydration are not covered by this experiment.

Restart requires an explicit human decision tied to the checkpoint digest, source run and conversation. One ordered new-run journal records intent, restoration, budget, native events and final state. It records intent before restore or native dispatch. Interrupted work after the checkpoint is designated lost. Stored history is an observation source, not an executable queue.

## Verification and limits

Lint, typecheck, build and all 47 offline tests passed. Tests exercise deletion, a non-main base commit, an unbundled base-object rejection, executable modes, duplicate content, file/symlink transitions, dangling external links, hardlink rejection, malformed or incomplete recoverability, corrupted blobs/manifests, unsafe parent links, exact Restart authorization, late-event rejection and no dispatch on reopen. Crash injection covers interruptions after content, before manifest publication and after manifest publication but before the recoverable journal event. Independent review identified publication, identity and event-order gaps; those were corrected before the final native verification, which required exactly one matching test command in the restored working directory.

This is a single-writer research implementation. Inventory comparison and path checks do not establish a transaction against a malicious same-user process racing filesystem operations. Power-loss tests on real storage, atomic capture of concurrently edited projects, resumable restore failures and production multi-conversation scheduling remain future work. Native cleanup here confirms the observed foreground verification group; it does not override the [failed detached-child containment result](lifecycle-completion-2026-09-12.md).

The native session used inventoried global instructions from the harness-owned home. This is not proof of isolated production subscription configuration. Checkpoint restoration does not depend on the old provider session, but external services and arbitrary future model behavior are not reproducible from a file snapshot.

M1 remains incomplete because containment and final local delivery/reconciliation still need their own passing mechanisms. [Sandbox research](sandbox-direction-2026-09-12.md) identifies the next containment options without treating them as approved product choices.
