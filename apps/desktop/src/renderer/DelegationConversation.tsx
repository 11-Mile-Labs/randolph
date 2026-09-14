import { useEffect, useRef, useState } from 'react';
import type { DelegationSnapshot } from '@randolph/runtime/contracts';
import DelegationPanel from './DelegationPanel';

export default function DelegationConversation({
  runId,
  revision,
}: {
  runId: string;
  revision: number;
}) {
  const [snapshot, setSnapshot] = useState<DelegationSnapshot>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const value = await window.randolph.delegationSnapshot(runId);
        if (current === generation.current) {
          setSnapshot(value);
          setError(undefined);
        }
      } catch (cause) {
        if (current === generation.current)
          setError(cause instanceof Error ? cause.message : 'Could not load delegation.');
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [runId, revision]);
  const apply = async (request: () => Promise<DelegationSnapshot>): Promise<void> => {
    const current = ++generation.current;
    const result = await request();
    if (current === generation.current) {
      setSnapshot(result);
      setError(undefined);
    }
  };
  return (
    <>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot?.plan ? (
        <DelegationPanel
          snapshot={snapshot}
          onRevise={(input) => apply(() => window.randolph.reviseDelegation(input))}
          onReject={(input) => apply(() => window.randolph.rejectDelegation(input))}
          onApprove={(input) => apply(() => window.randolph.approveDelegation(input))}
          onSavePreset={(input) => apply(() => window.randolph.saveDelegationPreset(input))}
        />
      ) : null}
    </>
  );
}
