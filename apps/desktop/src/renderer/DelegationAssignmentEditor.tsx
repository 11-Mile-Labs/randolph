import type {
  DelegationAssignment,
  DelegationLimits,
  DelegationRole,
} from '@randolph/runtime/contracts';
import { rawLines, writeList } from './delegation-plan-editor';

type Props = {
  assignments: DelegationAssignment[];
  limits: DelegationLimits;
  canEdit: boolean;
  busy: boolean;
  onLimitsChange: (value: Partial<DelegationLimits>) => void;
  onAssignmentChange: (index: number, value: Partial<DelegationAssignment>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
};

const roles: DelegationRole[] = [
  'worker',
  'main-integration',
  'runtime-verification',
  'review',
  'main-synthesis',
];

export default function DelegationAssignmentEditor({
  assignments,
  limits,
  canEdit,
  busy,
  onLimitsChange,
  onAssignmentChange,
  onAdd,
  onRemove,
}: Props) {
  return (
    <>
      <fieldset className="delegation-limits" disabled={busy || !canEdit}>
        <legend>Execution limits</legend>
        {(
          [
            ['maxWorkers', 'Maximum workers'],
            ['maxParallel', 'Maximum parallel'],
            ['maxAttempts', 'Maximum attempts'],
            ['activeMinutes', 'Active minutes'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              aria-label={label}
              type="number"
              min="1"
              value={limits[key]}
              onChange={(event) => onLimitsChange({ [key]: Number(event.target.value) })}
            />
          </label>
        ))}
      </fieldset>

      <div className="delegation-assignments" aria-label="Delegation assignments">
        {assignments.map((assignment, index) => (
          <details key={index} className="delegation-assignment" open={index === 0}>
            <summary>
              <span>{assignment.task || `Assignment ${index + 1}`}</span>
              <small>
                {assignment.role} · {assignment.harness} · {assignment.model || 'model required'}
              </small>
            </summary>
            <div className="delegation-fields">
              <label>
                Task
                <input
                  aria-label={`Assignment ${index + 1} task`}
                  value={assignment.task}
                  disabled={busy || !canEdit}
                  onChange={(event) => onAssignmentChange(index, { task: event.target.value })}
                />
              </label>
              <label>
                Assignment ID
                <input
                  aria-label={`Assignment ${index + 1} ID`}
                  value={assignment.id}
                  disabled={busy || !canEdit}
                  onChange={(event) => onAssignmentChange(index, { id: event.target.value })}
                />
              </label>
              <label>
                Role
                <select
                  aria-label={`Assignment ${index + 1} role`}
                  value={assignment.role}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { role: event.target.value as DelegationRole })
                  }
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Harness
                <select
                  aria-label={`Assignment ${index + 1} harness`}
                  value={assignment.harness}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, {
                      harness: event.target.value as DelegationAssignment['harness'],
                    })
                  }
                >
                  <option value="codex">Codex</option>
                  <option value="grok">Grok</option>
                </select>
              </label>
              <label>
                CLI
                <input
                  aria-label={`Assignment ${index + 1} CLI`}
                  value={assignment.executable}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { executable: event.target.value })
                  }
                />
              </label>
              <label>
                CLI version
                <input
                  aria-label={`Assignment ${index + 1} CLI version`}
                  value={assignment.executableVersion}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { executableVersion: event.target.value })
                  }
                />
              </label>
              <label>
                Model
                <input
                  aria-label={`Assignment ${index + 1} model`}
                  value={assignment.model}
                  disabled={busy || !canEdit}
                  onChange={(event) => onAssignmentChange(index, { model: event.target.value })}
                />
              </label>
              <label>
                Reasoning effort
                <input
                  aria-label={`Assignment ${index + 1} effort`}
                  value={assignment.effort}
                  disabled={busy || !canEdit}
                  onChange={(event) => onAssignmentChange(index, { effort: event.target.value })}
                />
              </label>
              <label>
                Mode
                <select
                  aria-label={`Assignment ${index + 1} mode`}
                  value={assignment.mode}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, {
                      mode: event.target.value as DelegationAssignment['mode'],
                    })
                  }
                >
                  <option value="read-only">Read-only</option>
                  <option value="code">Code</option>
                </select>
              </label>
              <label>
                Source
                <input
                  aria-label={`Assignment ${index + 1} source`}
                  value={assignment.source}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, {
                      source: event.target.value as DelegationAssignment['source'],
                    })
                  }
                />
              </label>
              <label className="delegation-wide">
                Rationale
                <textarea
                  aria-label={`Assignment ${index + 1} rationale`}
                  rows={2}
                  value={assignment.rationale}
                  disabled={busy || !canEdit}
                  onChange={(event) => onAssignmentChange(index, { rationale: event.target.value })}
                />
              </label>
              <label>
                Dependencies
                <textarea
                  aria-label={`Assignment ${index + 1} dependencies`}
                  rows={2}
                  value={writeList(assignment.dependencies)}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { dependencies: rawLines(event.target.value) })
                  }
                />
              </label>
              <label>
                Integration inputs
                <textarea
                  aria-label={`Assignment ${index + 1} integration inputs`}
                  rows={2}
                  value={writeList(assignment.integrationInputs ?? [])}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { integrationInputs: rawLines(event.target.value) })
                  }
                />
              </label>
              <label>
                Deliverables
                <textarea
                  aria-label={`Assignment ${index + 1} deliverables`}
                  rows={3}
                  value={writeList(assignment.deliverables)}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { deliverables: rawLines(event.target.value) })
                  }
                />
              </label>
              <label>
                Completion criteria
                <textarea
                  aria-label={`Assignment ${index + 1} completion criteria`}
                  rows={3}
                  value={writeList(assignment.completionCriteria)}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { completionCriteria: rawLines(event.target.value) })
                  }
                />
              </label>
              <label>
                Repair attempts
                <input
                  aria-label={`Assignment ${index + 1} repair attempts`}
                  type="number"
                  min="0"
                  value={assignment.repairAttempts ?? 0}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { repairAttempts: Number(event.target.value) })
                  }
                />
              </label>
              <label className="delegation-checkbox">
                <input
                  aria-label={`Assignment ${index + 1} produces source`}
                  type="checkbox"
                  checked={Boolean(assignment.producesSource)}
                  disabled={busy || !canEdit}
                  onChange={(event) =>
                    onAssignmentChange(index, { producesSource: event.target.checked })
                  }
                />
                Produces immutable source
              </label>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !canEdit || assignments.length === 1}
              onClick={() => onRemove(index)}
            >
              Remove assignment
            </button>
          </details>
        ))}
        <button
          className="secondary-button"
          type="button"
          disabled={busy || !canEdit || assignments.length >= 24}
          onClick={onAdd}
        >
          Add assignment
        </button>
      </div>
    </>
  );
}
