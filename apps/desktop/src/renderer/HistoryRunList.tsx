import type { Run } from '@randolph/runtime/contracts';

type Props = {
  runs: Run[];
  selected?: string;
  busy: boolean;
  onSelect: (runId: string) => void;
};

export default function HistoryRunList({ runs, selected, busy, onSelect }: Props) {
  return (
    <nav aria-label="Historical runs">
      {runs.map((item) => (
        <button
          key={item.id}
          disabled={busy}
          className={item.id === selected ? 'selected' : ''}
          onClick={() => onSelect(item.id)}
        >
          <strong>{new Date(item.createdAt).toLocaleString()}</strong>
          <span>
            {item.status} · {item.checkpoints?.length ?? 0} checkpoints
          </span>
        </button>
      ))}
    </nav>
  );
}
