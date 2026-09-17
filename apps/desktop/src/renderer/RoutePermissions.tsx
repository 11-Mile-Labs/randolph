import type {
  HarnessId,
  HarnessInfo,
  HarnessInstallation,
  HarnessRoute,
} from '@randolph/runtime/contracts';

type Props = {
  enabledRoutes: HarnessRoute[] | undefined;
  harnessId: HarnessId;
  harness: HarnessInfo | undefined;
  installations: HarnessInstallation[];
  busy: boolean;
  onEnabledRoutesChange: (enabledRoutes: HarnessRoute[]) => void;
};

export default function RoutePermissions({
  enabledRoutes,
  harnessId,
  harness,
  installations,
  busy,
  onEnabledRoutesChange,
}: Props) {
  return (
    <fieldset className="route-permissions" disabled={busy}>
      <legend>Project CLI permissions</legend>
      {enabledRoutes === undefined ? (
        <>
          <p>
            This project uses its selected main agent. Enabling additional worker CLIs requires
            explicit project permissions.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={!harness?.executable}
            onClick={() => {
              onEnabledRoutesChange(
                harness?.executable ? [{ harness: harnessId, executable: harness.executable }] : [],
              );
            }}
          >
            Set project CLI permissions
          </button>
        </>
      ) : (
        <>
          <p>
            Only enabled CLIs can start new runs. Saved changes leave active runs on their original
            permissions.
          </p>
          {[
            ...installations.map((item) => ({ harness: harnessId, executable: item.executable })),
            ...enabledRoutes.filter(
              (route) =>
                route.harness !== harnessId ||
                !installations.some((item) => item.executable === route.executable),
            ),
          ].map((route) => (
            <label key={`${route.harness}:${route.executable}`}>
              <input
                type="checkbox"
                checked={enabledRoutes.some(
                  (item) => item.harness === route.harness && item.executable === route.executable,
                )}
                onChange={(event) => {
                  onEnabledRoutesChange(
                    event.target.checked
                      ? [...enabledRoutes, route]
                      : enabledRoutes.filter(
                          (item) =>
                            item.harness !== route.harness || item.executable !== route.executable,
                        ),
                  );
                }}
              />
              <span>
                Allow {route.harness} · {route.executable}
              </span>
            </label>
          ))}
          {!enabledRoutes.length ? (
            <p>No CLI is enabled. New execution will be blocked until you enable one.</p>
          ) : null}
          {harness?.executable &&
          !enabledRoutes.some(
            (route) => route.harness === harnessId && route.executable === harness.executable,
          ) ? (
            <p>The selected default CLI is disabled for new runs.</p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
