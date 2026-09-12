# Randolph

A desktop workspace for coordinating AI agents around your projects.

Bring your existing AI subscriptions, choose the lead agent for each conversation, and keep work, decisions, and approvals visible across projects.

An independent project from [11 Mile Labs](https://github.com/11-Mile-Labs).

## Status

Product design and harness compatibility research are in progress. There is no installable application yet. The planned first release targets macOS.

## What we are building

- **Projects with shared context.** Define purpose, important documents, instructions, skills, and workflows once, with configuration you can inspect and manage through the app.
- **Your choice of lead agent.** Select a harness, model, and effort level per project or conversation. Coordinate multiple conversations across multiple projects.
- **Execution that fits the task.** Let the lead agent handle simple work directly and propose additional agents when they provide a concrete benefit.
- **Visible work.** See current actions, delegation, waiting states, and approvals without opening raw logs. Expand the evidence when you need detail.
- **Reviewable outcomes.** Use isolated Git worktrees by default, inspect results, and explicitly approve final commit and merge. Pushing remains a separate action.
- **Useful history and learning.** Retain searchable run evidence, project and global lessons, and checkpoints for explicitly requested restarts.

## Integration direction

The initial target harnesses are Codex, Claude, and Grok through their installed CLIs and existing subscription authentication. Support is subject to capability verification for each harness version. Direct model API billing and automatic API fallback are outside the initial scope.

The design separates the desktop interface, local execution runtime, harness adapters, and durable storage. Agents make task decisions; application code controls execution and approvals. Protocol support alone does not establish reliable cancellation, approval enforcement, or recovery.

No application account or required cloud backend is planned. Harnesses and enabled integrations still communicate with their respective services.

## Open-source direction

The desktop application and execution runtime are intended for open-source release. License selection is pending. Personal service integrations and private operational data remain separate from the public core.

Implementation milestones, installation instructions, and contribution guidance will be added as the project develops.
