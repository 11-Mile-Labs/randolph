import type { ProjectContext, ProjectSetupSnapshot } from '@randolph/runtime/contracts';

export default function ProjectSetupProposal({
  selectedInspection,
  latest,
  setup,
  draft,
  updateDraft,
}: {
  selectedInspection:
    | NonNullable<NonNullable<ProjectSetupSnapshot['inspections'][number]['proposal']>['value']>
    | undefined;
  latest?: ProjectSetupSnapshot['inspections'][number];
  setup?: ProjectSetupSnapshot;
  draft: ProjectContext;
  updateDraft: (value: ProjectContext) => void;
}) {
  if (!selectedInspection) return <p className="muted-copy">No inspection proposal yet.</p>;
  return (
    <section className="setup-proposal">
      <h3>
        Latest proposal{' '}
        {latest?.approvedRevision === setup?.context.revision ? (
          <span className="setup-ready">Approved</span>
        ) : latest?.canApprove ? (
          <span className="setup-ready">Ready to approve</span>
        ) : (
          <span>Needs another inspection</span>
        )}
      </h3>
      <label>
        Proposed purpose
        <input
          aria-label="Proposed purpose"
          value={draft.purpose}
          onChange={(event) => updateDraft({ ...draft, purpose: event.target.value })}
        />
      </label>
      <label>
        Proposed instructions
        <textarea
          aria-label="Proposed instructions"
          value={draft.instructions}
          onChange={(event) => updateDraft({ ...draft, instructions: event.target.value })}
          rows={5}
        />
      </label>
      <h4>Documents</h4>
      {draft.documents.map((doc, index) => (
        <div className="setup-document" key={index}>
          <input
            aria-label={`Document ${index + 1} path`}
            value={doc.path}
            onChange={(event) => {
              const documents = [...draft.documents];
              documents[index] = { ...doc, path: event.target.value };
              updateDraft({ ...draft, documents });
            }}
          />
          <input
            aria-label={`Document ${index + 1} description`}
            value={doc.description}
            onChange={(event) => {
              const documents = [...draft.documents];
              documents[index] = { ...doc, description: event.target.value };
              updateDraft({ ...draft, documents });
            }}
          />
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              updateDraft({
                ...draft,
                documents: draft.documents.filter((_, item) => item !== index),
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <button
        className="secondary-button"
        type="button"
        onClick={() =>
          updateDraft({
            ...draft,
            documents: [...draft.documents, { path: '', description: '' }],
          })
        }
      >
        Add document
      </button>
      <h4>Evidence</h4>
      <ul>
        {selectedInspection.evidence.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h4>Questions</h4>
      <ul>
        {selectedInspection.questions.length ? (
          selectedInspection.questions.map((item) => <li key={item}>{item}</li>)
        ) : (
          <li>None recorded.</li>
        )}
      </ul>
    </section>
  );
}
