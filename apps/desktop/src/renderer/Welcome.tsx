import type { HarnessInfo } from '@randolph/runtime/contracts';
import { LogoMark, PlusIcon } from './icons';

export type WelcomeProps = {
  hasProjects: boolean;
  busy: boolean;
  harness?: HarnessInfo;
  onAddProject: () => void;
};

export default function Welcome({ hasProjects, busy, harness, onAddProject }: WelcomeProps) {
  const harnessReady = Boolean(
    harness?.available && harness.authenticated && harness.models.length > 0,
  );
  return (
    <div className="welcome">
      <LogoMark />
      <span className="eyebrow">Read-only workspace</span>
      <h1>{hasProjects ? 'Choose a conversation' : 'Bring a project into focus'}</h1>
      <p>
        {hasProjects
          ? 'Select a conversation from the sidebar, or start a new one inside a project.'
          : 'Add a local project to inspect it, ask questions, and follow native activity as it happens.'}
      </p>
      {!hasProjects ? (
        <button className="primary-button" type="button" onClick={onAddProject} disabled={busy}>
          <PlusIcon />
          Add your first project
        </button>
      ) : null}
      <span className={`harness-readiness${harnessReady ? ' ready' : ''}`} role="status">
        <span aria-hidden="true" />
        {!harness
          ? 'Checking native harness…'
          : harnessReady
            ? 'Native harness ready'
            : 'Native harness unavailable'}
      </span>
      <small>
        Code mode edits an isolated Git worktree and requires final review before delivery.
      </small>
    </div>
  );
}
