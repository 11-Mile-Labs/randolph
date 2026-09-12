# Native harness profiles

Status: accepted direction, 2026-09-12.

## V1

Randolph uses installed native harnesses with their existing profiles and subscription logins. The Codex adapter currently reuses the normal Codex profile with per-launch controls; Grok is the next adapter and must likewise start with its existing native profile and login. Claude remains planned work.

Randolph may apply verified per-launch configuration, permission, tool, and environment controls without changing the user's saved harness configuration. Existing-profile reuse does not establish that every inherited capability is suitable for Randolph. Each adapter must report demonstrated limits and refuse unsupported execution modes. Credentials remain owned by the native CLI; no token extraction or automatic model API fallback is introduced.

## After v1

Optional separate profiles are deferred. They must be designed as a coherent capability across harnesses where feasible, rather than introduced as a Grok-specific workaround.

Before implementing separate profiles, complete a full product review, architecture design, and independent reviews. The design must cover onboarding and native login, shared versus isolated settings, credentials and machine transfer, context and extension inheritance, upgrade and migration behavior, user control, recovery, and differences between harness capabilities. That review must resolve which guarantees can be consistent and which must remain explicitly harness-specific.

This decision authorizes v1 integration using existing profiles. It does not authorize implementing a separate-profile feature before the required post-v1 reviews.
