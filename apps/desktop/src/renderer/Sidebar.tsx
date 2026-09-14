import type { Conversation, Project, RunEvent } from '@randolph/runtime/contracts';
import { LogoMark, PlusIcon } from './icons';
import { unreadCount } from './workspace-helpers';

export type SidebarProps = {
  projects: Project[];
  conversations: Conversation[];
  events: RunEvent[];
  selectedConversationId?: string;
  screen: 'workspace' | 'chat' | 'settings';
  busy: boolean;
  onAddProject: () => void;
  onCreateConversation: (projectId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenProjectMemory: (projectId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onOpenProjectSetup: (projectId: string) => void;
  onOpenProjectHistory: (projectId: string) => void;
};

export default function Sidebar({
  projects,
  conversations,
  events,
  selectedConversationId,
  screen,
  busy,
  onAddProject,
  onCreateConversation,
  onSelectConversation,
  onOpenWorkspace,
  onOpenSettings,
  onOpenProjectMemory,
  onOpenProjectSettings,
  onOpenProjectSetup,
  onOpenProjectHistory,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Projects and conversations">
      <div className="brand-row">
        <LogoMark />
        <div>
          <strong>Randolph</strong>
          <span>Project workspace</span>
        </div>
      </div>

      <button className="add-project-button" type="button" onClick={onAddProject} disabled={busy}>
        <PlusIcon />
        Add project
      </button>

      <nav className="app-navigation" aria-label="Application">
        <button
          className={screen === 'workspace' ? 'selected' : ''}
          type="button"
          onClick={onOpenWorkspace}
          aria-current={screen === 'workspace' ? 'page' : undefined}
        >
          Workspace
        </button>
        <button
          className={screen === 'settings' ? 'selected' : ''}
          type="button"
          onClick={onOpenSettings}
          aria-current={screen === 'settings' ? 'page' : undefined}
        >
          Settings
        </button>
      </nav>

      <nav className="project-list" aria-label="Project conversations">
        {projects.length === 0 ? (
          <p className="sidebar-empty">Add a project to begin a conversation.</p>
        ) : (
          projects.map((project) => {
            const projectConversations = conversations
              .filter((conversation) => conversation.projectId === project.id)
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return (
              <section className="project-group" key={project.id}>
                <div className="project-heading">
                  <div>
                    <strong title={project.root}>{project.name}</strong>
                    <span>{project.root}</span>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`New conversation in ${project.name}`}
                    title="New conversation"
                    onClick={() => onCreateConversation(project.id)}
                    disabled={busy}
                  >
                    <PlusIcon />
                  </button>
                </div>
                <div className="conversation-list">
                  <div className="project-links" aria-label={`${project.name} tools`}>
                    <button type="button" onClick={() => onOpenProjectMemory(project.id)}>
                      Memory
                    </button>
                    <button type="button" onClick={() => onOpenProjectHistory(project.id)}>
                      Run history
                    </button>
                    <button type="button" onClick={() => onOpenProjectSetup(project.id)}>
                      Project setup
                    </button>
                    <button type="button" onClick={() => onOpenProjectSettings(project.id)}>
                      Project settings
                    </button>
                  </div>
                  {projectConversations.length === 0 ? (
                    <button
                      className="new-conversation-prompt"
                      type="button"
                      onClick={() => onCreateConversation(project.id)}
                      disabled={busy}
                    >
                      Start a conversation
                    </button>
                  ) : (
                    projectConversations.map((conversation) => {
                      const unread = unreadCount(events, conversation);
                      return (
                        <button
                          className={`conversation-button${selectedConversationId === conversation.id ? ' selected' : ''}`}
                          type="button"
                          key={conversation.id}
                          onClick={() => onSelectConversation(conversation.id)}
                          aria-current={
                            selectedConversationId === conversation.id ? 'page' : undefined
                          }
                        >
                          <span>{conversation.title}</span>
                          {unread > 0 ? (
                            <span className="unread-badge" aria-label={`${unread} unread events`}>
                              {unread > 99 ? '99+' : unread}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })
        )}
      </nav>
    </aside>
  );
}
