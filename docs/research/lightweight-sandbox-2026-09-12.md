# Lightweight sandbox investigation

**Status:** withdrawn following the [user's scope correction](sandbox-scope-2026-09-12.md). Reducing the footprint did not correct the unauthorized expansion of VMs into execution lifecycle control. The proposed topologies and next deliverable below are inactive historical research. No VM software has been installed, extracted or executed. No guest image has been downloaded.

## Correct the baseline

The Lima reference proposed a full Ubuntu cloud image, 2 GiB guest memory and an 8 GiB virtual disk. Those were experiment configuration choices, not measured minimum requirements and not intrinsic micro-VM overhead. The 8 GiB disk is virtual capacity; actual allocated storage and idle host memory had not been measured. Calling this footprint small was not justified for an app supporting concurrent work.

Keep its ownership findings and fault matrix, but park that installation plan. The next research question is whether a minimal guest can satisfy both the containment contract and a practical concurrent desktop workload.

## More suitable implementation candidate

Apple's Containerization package uses an optimized Linux kernel, a minimal root filesystem and a small init process (`vminitd`). Host-to-guest process control uses gRPC over vsock. This could remove a full Ubuntu boot stack and SSH from the product runtime. Apple describes sub-second container starts; this is an upstream claim, not a Randolph benchmark. The package can be integrated directly into an application, separately from Apple's service-backed `container` CLI. [Containerization 0.45.0 design](https://github.com/apple/containerization/blob/0.45.0/README.md).

Do not substitute another reassuring label for measurements. In the same tagged package, `VMConfiguration` defaults to **1 GiB** of configurable guest memory; the CLI resource configuration also defaults to 1 GiB. Neither default establishes idle physical footprint or the minimum viable workload. [Package configuration](https://github.com/apple/containerization/blob/0.45.0/Sources/Containerization/VMConfiguration.swift), [CLI resources](https://github.com/apple/container/blob/1.4.1/Sources/ContainerResource/Container/ContainerConfiguration.swift).

## Measure three costs separately

| Layer              | What to measure                                                                                                              | Why it matters                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Execution boundary | Kernel/init disk bytes; host physical footprint while idle; cold boot to usable control channel; warm start; stop latency    | Establishes the overhead Randolph adds before useful work.                              |
| Harness            | Additional installed bytes and idle/active memory for the exact Codex, Claude or Grok binary; guest-owned subscription login | A tiny guest with an incompatible CLI is not a viable result.                           |
| Project workload   | Toolchain/dependency bytes, build/test peak memory, writable changes                                                         | Builds and browsers may require gigabytes even when the boundary itself is lightweight. |

Measure one, two and four simultaneous active runs, with host memory pressure and aggregate physical footprint. Keep configured guest RAM, host physical memory, compressed download size, expanded image size, and writable disk allocation separate. Record cold/warm states and sample count; never publish a single best-case latency as the result.

A proposed first experiment sweeps supported memory settings (for example 128, 256 and 512 MiB) for a synthetic process only, recording unsupported settings and failures. These are test points, not promised requirements or approved product limits. Add the native harness only after the empty boundary's measurements and kill tests are credible. Measure complete workloads before setting product defaults.

## Concurrency and isolation choices to compare

Conversations do not inherently require live VMs. A conversation can retain chat/history while its execution environment is stopped. Tie any VM allocation to active work, preserve explicit restart after termination, and do not keep resources running solely because a conversation exists. Whether an idle but live harness can be released without losing useful state still needs adapter-specific proof.

Two candidate topologies deserve a measured comparison:

- One minimal VM per active run gives a direct whole-guest Stop boundary. Shared immutable base images and bounded writable run disks could reduce disk duplication; memory sharing must be measured rather than assumed.
- One VM per project amortizes the guest overhead. Individual conversations then need another enforceable process boundary inside it. A guest-wide stop affects sibling work, so this topology cannot claim the same per-conversation isolation without an additional proof.

Neither topology is approved. A VM per chat, project or app should not become a default simply because a runtime makes it convenient.

## Next deliverable

Prepare the smallest direct-Containerization build/probe footprint, including its host build prerequisites and guest assets. Then seek execution authorization for that concrete experiment if new software is required. Do not install the parked Ubuntu/Lima candidate as a shortcut. Retain the detached-child, controller-loss, supervisor-loss and VMM-loss fault tests from the [reference plan](vm-feasibility-plan-2026-09-12.md).

The outcome must pair measured overhead with a containment verdict. Low memory does not compensate for surviving work after Stop, and successful termination does not make an excessive per-run footprint acceptable. Sandboxes remain a later product requirement unless the user changes that scope.
