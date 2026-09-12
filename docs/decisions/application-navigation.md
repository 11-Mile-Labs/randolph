# Application navigation and macOS identity

The desktop opens on Workspace, with application navigation permanently visible in the sidebar. Each project exposes conversations, Project settings, Memory, and Run history without requiring an active conversation. Opening Workspace or Settings does not clear unread conversation activity.

## Native application

`pnpm package:mac` builds `dist/macos/Randolph.app` for the current Mac architecture. The bundle includes production dependencies, uses the repository’s `randolph.png` for its icon, and carries the Randolph executable and bundle identity. Packaging occurs in a temporary workspace so production deployment cannot remove development dependencies from the checkout. External runtime dependencies are materialized at ordinary Node resolution paths before archive creation; pnpm’s private links are not sufficient inside the archive. The resulting bundle is signed ad hoc and checked locally. Public distribution, notarization, DMG creation, and updates remain pending.

The application menu includes About Randolph, Settings… (`⌘,`), Services, Hide, and Quit Randolph. File → Open Workspace uses `⌘1`. Edit, View, Window, Help, and Stop all work controls are available in the native menu. Settings navigation is retained until the renderer acknowledges it, including when a background window must be recreated.

## Application preferences

Settings works without a project or authenticated harness. `config.app.yaml` in the app-data directory stores theme, background execution, and notification preferences. Writes validate the document and reject stale revisions or malformed existing files. External edits can be loaded through Reload settings. Global lesson policy remains in the existing `config.memory.yaml`, with separate save controls and revision checking. Saving one section preserves unsaved changes in the other.

Background execution is off by default. With it off, closing the window stops the application; active work requires an explicit stop confirmation, with an option to open Settings. With it on, closing hides the window and retains the runtime. A menu-bar icon exposes Open Randolph, Settings, Stop all work, and Quit. Explicit Quit still stops active work through the runtime shutdown path. Interrupted work never restarts automatically.

Completed-run, failure, and review-ready notifications are independently opt-in. They are emitted for new events while the app is not focused; historical events are not replayed at startup. macOS notification permission and system settings still control presentation.

Background execution does not solve detached-descendant termination or hard owner-loss shutdown. Those existing release blockers remain open, as does Pause/Resume.

## Verification

Runtime tests exercise persistence without project/authentication prerequisites, separate global policy, stale external edits, and malformed files. Electron acceptance covers sidebar and keyboard access, native Settings navigation after background-window destruction, persisted appearance, independent settings drafts, and project controls without entering a conversation. The same navigation acceptance test can run against an installed bundle by setting `RANDOLPH_TEST_EXECUTABLE` to its executable. Native macOS visual inspection requires an unlocked desktop.

The installed bundle passed the navigation acceptance test, including native menu entries and window recreation. Direct macOS inspection also confirmed the Randolph menu title, About/Settings/Quit entries, and opening the Settings screen from the native menu in the installed application.
