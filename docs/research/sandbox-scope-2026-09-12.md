# Sandbox scope correction

The user clarified on 2026-09-12 that micro-VMs were proposed **only for sandboxing work for safety**. Using them as Randolph's general execution architecture, process supervisor, Stop mechanism, or restart/checkpoint infrastructure was an assistant-introduced expansion and is rejected.

Sandboxing remains an optional later safety feature. No VM implementation, installation, or topology has been selected. The app's lifecycle controls must be designed independently of whether sandboxing is enabled; the failed detached-process test remains unresolved and does not authorize a VM solution.

The requested comparative research concerns how other harnesses and applications, including Hermes and OpenClaw, isolate work: what is protected, what remains exposed, what is optional, and the practical cost. It must not assume that a VM is necessary or use that research to expand the role of VMs.

The previous VM lifecycle proposal and its configuration are withdrawn. Preserve them only as historical research showing the rejected direction. Their proposed next steps are not active work. No VM runtime was installed or executed.

The completed [safety sandbox comparison](safety-sandbox-comparison-2026-09-12.md) is the current research reference. It compares native harness restrictions and optional tool/agent sandboxes without selecting a runtime.
