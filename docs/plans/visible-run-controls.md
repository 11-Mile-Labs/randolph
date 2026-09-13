# Visible run controls and queues

Implementation slice within the approved delegation execution plan. This does not change v1 scope or enable the production coordinator.

- [x] Separate decision revision from dispatch generation. Priority and budget edits preserve existing admissions; Pause, Stop, recovery, and exhaustion fence subsequent dispatch.
- [x] Add cancellation scoped to one run, including queued operations, while preserving unrelated work and cleanup quarantine.
- [x] Show retained activity, capacity waiting reasons, paused tasks, recorded active budget, and native/workspace cleanup without launching discovery or changing accounting.
- [ ] Connect exact typed control commands and retry receipts to a runtime-owned coordinator lifecycle. Pause closes admission and lets active stages settle; Stop cancels; Resume requires an explicit settled, current authorization.
- [ ] Add project/global control scopes and editable app/harness capacity. Retain included runs in each decision.
- [ ] Connect proposal approval and composer preset authorization to the production driver after repair and acceptance proofs. Approval itself queues the authorized graph; no redundant Start approval.

The activity panel is observational. It offers no metadata-only Resume. Recorded active minutes exclude queue and paused waiting time; they update at accounting boundaries. Interrupted records never restart on app launch. Unknown workspace cleanup remains separate from occupied native process slots.
