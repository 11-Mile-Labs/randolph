import type { Conversation, Project, Run } from '@randolph/runtime/contracts';

type Props = {
  projects: Project[];
  conversations: Conversation[];
  runs: Run[];
  busy: boolean;
  onAddProject: () => void;
  onOpenConversation: (conversationId: string) => void;
  onCreateConversation: (projectId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onOpenProjectSetup: (projectId: string) => void;
  onOpenMemory: (projectId: string) => void;
  onOpenHistory: (projectId: string) => void;
};

export default function WorkspaceHome({
  projects,
  conversations,
  runs,
  busy,
  onAddProject,
  onOpenConversation,
  onCreateConversation,
  onOpenProjectSettings,
  onOpenProjectSetup,
  onOpenMemory,
  onOpenHistory,
}: Props) {
  return (
    <section className="workspace-home" aria-labelledby="workspace-title">
      <header className="workspace-home-header">
        <img src="/randolph.png" alt="Randolph" className="workspace-mark" />
        <div>
          <span className="eyebrow">Workspace</span>
          <h1 id="workspace-title">Your projects, in one place.</h1>
          <p>Open a conversation or manage the project context before you start.</p>
        </div>
        <button className="primary-button" type="button" onClick={onAddProject} disabled={busy}>
          Add project
        </button>
      </header>
      {projects.length === 0 ? (
        <div className="workspace-empty">
          <h2>Add your first project</h2>
          <p>Choose a local folder to inspect, discuss, and retain run history.</p>
          <button className="primary-button" type="button" onClick={onAddProject} disabled={busy}>
            Add your first project
          </button>
        </div>
      ) : (
        <div className="workspace-projects">
          {projects.map((project) => {
            const projectConversations = conversations
              .filter((item) => item.projectId === project.id)
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const projectRuns = runs.filter((item) => item.projectId === project.id);
            return (
              <article className="workspace-project-card" key={project.id}>
                <div>
                  <span className="eyebrow">Project</span>
                  <h2>{project.name}</h2>
                  <code title={project.root}>{project.root}</code>
                  <p>
                    {projectConversations.length} conversation
                    {projectConversations.length === 1 ? '' : 's'} · {projectRuns.length} retained
                    run{projectRuns.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="workspace-card-actions">
                  {projectConversations[0] ? (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => onOpenConversation(projectConversations[0]!.id)}
                    >
                      Open latest conversation
                    </button>
                  ) : null}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onCreateConversation(project.id)}
                    disabled={busy}
                  >
                    New conversation
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenProjectSettings(project.id)}
                  >
                    Project settings
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenProjectSetup(project.id)}
                  >
                    Project setup
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenMemory(project.id)}
                  >
                    Memory
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenHistory(project.id)}
                  >
                    Run history
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
