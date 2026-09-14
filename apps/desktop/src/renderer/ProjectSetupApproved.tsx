import type { ProjectSetupSnapshot } from '@randolph/runtime/contracts';

export default function ProjectSetupApproved({ setup }: { setup?: ProjectSetupSnapshot }) {
  return (
    <section className="setup-approved">
      <h3>Approved context</h3>
      <p>
        <strong>Purpose</strong>
        <br />
        {setup?.context.value.purpose || 'No approved purpose yet.'}
      </p>
      <p>
        <strong>Instructions</strong>
        <br />
        {setup?.context.value.instructions || 'No approved instructions yet.'}
      </p>
      <p>
        <strong>Documents</strong>
      </p>
      {setup?.context.value.documents.length ? (
        <ul>
          {setup.context.value.documents.map((doc) => (
            <li key={doc.path}>
              <code>{doc.path}</code> — {doc.description}
            </li>
          ))}
        </ul>
      ) : (
        <p>No document references.</p>
      )}
      <p>
        Revision <code>{setup?.context.revision ?? 'none'}</code>
      </p>
      {setup?.context.error ? (
        <p className="inline-error" role="alert">
          {setup.context.error}
        </p>
      ) : null}
    </section>
  );
}
