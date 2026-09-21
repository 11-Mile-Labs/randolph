import type { Message, ReviewRecord, RunEvent } from '@randolph/runtime/contracts';

type Props = {
  runId: string;
  reviews: ReviewRecord[];
  events: RunEvent[];
  messages: Message[];
};

export default function RecordedOutcomeSections({ runId, reviews, events, messages }: Props) {
  return (
    <>
      <section aria-label="Recorded delivery" className="history-delivery">
        <h3>Recorded delivery</h3>
        <p>These are saved outcomes from the original run. Opening history does not repeat them.</p>
        {!reviews.some((review) => review.runId === runId) ? (
          <p>No delivery review recorded.</p>
        ) : (
          reviews
            .filter((review) => review.runId === runId)
            .map((review) => (
              <article key={review.id}>
                <strong>{review.status}</strong>
                <p>
                  {review.verification
                    ? `Checks ${review.verification.status}`
                    : 'Checks not recorded'}
                </p>
                {review.commitOid ? (
                  <p>
                    Retained commit <code>{review.commitOid}</code>
                  </p>
                ) : (
                  <p>No confirmed commit recorded.</p>
                )}
                <p>
                  {review.merged ? `Merged to ${review.basis.parentBranch}` : 'Merge not confirmed'}{' '}
                  · {review.cleaned ? 'Worktree removed' : 'Cleanup not confirmed'}
                </p>
                {review.error ? <p>{review.error}</p> : null}
              </article>
            ))
        )}
      </section>
      <section aria-label="Recorded activity">
        <h3>Recorded activity</h3>
        <ol className="history-timeline">
          {events
            .filter((event) => event.runId === runId)
            .map((event) => (
              <li key={event.sequence}>
                <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
                <p>{event.summary}</p>
                <details>
                  <summary>{event.type}</summary>
                  <pre>{JSON.stringify(event.data, null, 2)}</pre>
                </details>
              </li>
            ))}
        </ol>
      </section>
      <h3>Messages from this run</h3>
      {messages
        .filter((message) => message.runId === runId)
        .map((message) => (
          <article className="history-message" key={message.id}>
            <strong>{message.role}</strong>
            <p>{message.text}</p>
          </article>
        ))}
    </>
  );
}
