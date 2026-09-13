# Disposable VM containment proof

**Status:** withdrawn following the [user's scope correction](sandbox-scope-2026-09-12.md). Using a VM to solve Randolph's general Stop/lifecycle problem was outside the proposed safety-sandbox scope. This document is historical only; its installation, fault matrix, and execution steps are inactive. The existing host-process containment result remains failed.

## Question and bounded scope

Can a VM owner provide the missing Stop boundary, including when the controller or supervisor dies? Use one disposable Linux guest with synthetic processes. No project mount, native harness, account login, credential transfer, model inference, API charge, or production integration is needed to answer this first question.

The candidate [configuration](../../experiments/vm-containment/config.vm.yaml) and [download manifest](../../experiments/vm-containment/downloads.json) pin Lima 2.2.0 and an Ubuntu 24.04 arm64 image. The YAML is a source-reviewed candidate, not an executed or Lima-validated configuration. Its image path deliberately requires rendering into an owned experiment directory before use.

## Proposed machine changes

Use Lima's supported portable archive installation, extracted into a private experiment directory. Do not use Homebrew, sudo, autostart, socket_vmnet, Rosetta, Docker, or a LaunchAgent. VZ does not require QEMU. The current Homebrew formula independently confirms no runtime dependencies or service, but the portable archive is the selected probe route. [Installation](https://lima-vm.io/docs/installation/), [release](https://github.com/lima-vm/lima/releases/tag/v2.2.0), [formula metadata](https://formulae.brew.sh/api/formula/lima.json).

| Resource | Proposed footprint | Evidence or limit |
| --- | --- | --- |
| Lima runtime | 37,586,365 download bytes; 80,851,651 expanded regular-file bytes | Archive downloaded into memory, digest checked and headers inspected; nothing extracted or executed. Includes native Linux arm64 guest agent; additional foreign-architecture agents are unnecessary. |
| Ubuntu image | 615,630,848 download bytes | Dated URL returned HTTP 200. Expected SHA-256 is pinned from the Lima release; actual image verification is still required. |
| VM | 2 CPUs, 2 GiB RAM, 8 GiB virtual disk | One VM at a time. Sparse disk allocation and conversion overhead are measured during execution, not promised in advance. Require 12 GiB free before starting; stop preparation if allocation exceeds that budget. |
| Services | Per-experiment Lima processes, local SSH transport and user-mode network | No configured login/boot service. Inventory actual child processes and listening sockets before the fixture starts. |
| Duration | At most 20 minutes; one preparation attempt and one pass through cases | Setup failure is unverified; do not silently switch runtime/image or increase the budget. |
| Retained output | Config, versions/digests, ordered JSONL events, case results, cleanup receipt, readable report | Disposable runtime and guest disk are removed after verified shutdown; credentials are never involved. |

The release archive SHA-256 matches GitHub's official asset metadata; that detects corruption against the retrieved metadata and is not a claim of independent publisher-signature verification. Validate the image checksum before boot. A missing dated image is a preparation failure, not permission to use an unpinned latest image. [Pinned image list](https://github.com/lima-vm/lima/blob/v2.2.0/templates/_images/ubuntu-24.04.yaml).

## Owned storage and configuration

Create an exclusive, mode-0700 directory under the global Randolph experiment store. Keep `runtime/`, `downloads/`, `lima/`, and `logs/` together, with an ownership token and recorded directory identities. Use a short run identifier and instance name `p`; check the resolved Lima socket paths against macOS's 104-character limit. A symlink shortcut does not help because Lima resolves `LIMA_HOME`. Do not put the VM disk in OS temporary storage; temporary extraction scratch alone is disposable. [Path handling](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/dirnames/dirnames.go).

Set `LIMA_HOME` to the fresh owned `lima/` directory on every command. Do not create or read overrides from the user's normal Lima home. Resolve image and executable paths explicitly; use a clean child environment with no provider tokens, SSH-agent socket, proxy credentials, plugin paths, or inherited Lima variables. Do not change the host's HOME or SSH configuration.

Download the image directly into owned `downloads/`, hash it, and render its absolute path into a copy of the candidate YAML. Lima's normal HTTP cache is outside `LIMA_HOME`, in the OS user cache. Its local-file download branch bypasses that HTTP cache; use that path and record any unexpected cache creation before proceeding. Never prune another Lima installation's cache. [Downloader implementation](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/downloader/downloader.go).

After portable extraction, validate the rendered YAML with the pinned `limactl validate`, then create the instance without starting it. Inspect effective configuration and fail if it contains mounts, provisioning commands, static forwards, extra disks, forwarded agents, host public keys, containerd, Rosetta, or unpinned images. Record runtime libraries and entitlements before first execution; an unexpected prerequisite ends preparation rather than triggering installation.

Plain mode disables mounts and several integrations, but retains static forwarding, user provisioning, guest user/SSH-key setup, and networking. The candidate explicitly sets the relevant lists empty. `ssh.overVsock: false` selects an explicit loopback SSH transport to avoid a silent vsock fallback on Ubuntu 24.04. Lima-generated SSH keys stay in the owned Lima home; no existing key is copied. Inspect actual transport and sockets after boot. [Plain mode](https://lima-vm.io/docs/config/plain/), [versioned defaults](https://github.com/lima-vm/lima/blob/v2.2.0/templates/default.yaml), [SSH implementation](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/sshutil/sshutil.go).

**This candidate is not network-isolated.** With `networks: []`, VZ creates its default in-process gVisor network. Guest access to host services and outbound destinations remains a separate production concern. Only a fixed synthetic fixture runs here; no private data or arbitrary agent workload is admitted. Initial guest setup may contact Ubuntu package mirrors. No host firewall changes are proposed. [VZ networking source](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/vz/vm_darwin.go), [host reachability](https://lima-vm.io/docs/config/network/user/).

## Fault matrix and evidence

First inventory which process actually owns VZ for the pinned release. The `limactl start` command returning or dying is not proof that its VM died. Record PID, creation identity, executable and ownership links; a PID file alone is insufficient. Keep the fixture controller, intended run supervisor and independent observer distinguishable in logs. Record if two nominal roles are actually the same process; do not count that as two independent cases.

The source-reviewed launch candidate is `limactl start --foreground`: it execs into the hostagent rather than returning with a background VM. The normal v2.2.0 Darwin build embeds VZ in that hostagent; assert hostagent and VZ PID identities match at runtime. An external-driver build needs a different ownership proof. `stop -f` logs signal errors without propagating a reliable success result, so its exit code cannot certify shutdown. Graceful VZ stop may wait 30 seconds, exceeding the five-second contract. [Foreground start](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start_unix.go), [VZ registration](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/vz/register.go), [forced stop](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/stop.go), [graceful VZ stop](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/vz/vz_driver_darwin.go).

The guest fixture must double-fork, call `setsid`, close inherited terminal descriptors, and prove that it survives the submitting SSH command's exit. It emits a sequence-numbered heartbeat and writes a delayed canary after six seconds. Use both guest-local fsynced records and an independent host observation channel. A positive control must show the canary before testing shutdown; otherwise absence proves nothing.

| Case | Trigger | Required observation |
| --- | --- | --- |
| Control | End fixture's submitting SSH command normally | Detached guest process remains alive; delayed canary appears. |
| Explicit Stop | Invoke the proposed forced VM-stop control | Actual VZ owner exits and guest execution stops within the existing five-second deadline. |
| Controller loss | SIGKILL only the controller | Proposed owner-loss mechanism stops the guest within five seconds, without observer rescue. |
| Supervisor loss | SIGKILL only the proposed supervisor | Guest stops within five seconds. Any surviving VMM makes this case fail, even if the controller later notices. |
| VMM loss | SIGKILL the verified VM owner | Detached guest work stops; unrelated host sentinel remains alive. |
| Reopen and recovery | Open retained host evidence; subsequently perform a separate explicit guest restart | Read-only reopen launches nothing. Explicit restart yields a new boot ID, no auto-restarted fixture, and a separately verified pre-fault host checkpoint. |

Use monotonic host timestamps for deadlines. Loss of SSH, absence of heartbeats, or Lima reporting `Stopped` alone cannot pass a case: pair those observations with verified VM-owner termination and post-fault inspection. Observe beyond the delayed-canary deadline. Distinguish an attempted send from host receipt; network loss must not masquerade as process termination.

After recording the verdict, an observer may rescue surviving owned processes. Rescue is always reported and never converts failure to success. Preserve the guest disk when its writer's death cannot be verified. If reboot or filesystem recovery prevents reliable canary inspection, mark that evidence unverified rather than interpreting missing data as successful containment.

A host checkpoint must be fully exported, hashed, fsynced and acknowledged before the injected fault. Reopening it can prove that durable state survived; it does not prove unsaved guest data survived forced shutdown. The already-passing checkpoint experiment remains separate from this VM proof.

## Cleanup and result boundary

Stop only the named instance under the explicit experiment `LIMA_HOME`. Verify all recorded owned VM/runtime identities have exited, then use instance-scoped deletion and remove only owned runtime/image/scratch paths whose identities still match. Never use a global process-name kill or global Lima prune. Re-inventory processes, sockets, autostart entries and cache paths; record cleanup independently from the immutable case verdicts.

The result will be one of: the proposed boundary passes these finite tests; a specific fault leaves work running; or preparation/observation is unverified. A passing result would justify the next guest-owned subscription-authentication proof. It would not certify adversarial isolation, approve a product platform floor, change in-repository worktree requirements, or complete M1 by itself.

Execution authorization covers only this temporary runtime and synthetic fault matrix. Installing a harness or completing a guest subscription login remains a subsequent, separately scoped step.
