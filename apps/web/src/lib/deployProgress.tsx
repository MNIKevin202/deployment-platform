import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DeployProgress } from "../types/api";

/**
 * A shared, live map of every in-flight deployment, keyed by appId.
 *
 * One EventSource is opened here and fanned out through context, so any
 * inline surface — a table status cell, an app card, the app-detail header —
 * can show the same measured percentage without each opening its own stream.
 *
 * The site-wide DeploymentProgressOverlay keeps its own subscription: it
 * predates this and owns the success/failure notifications. This provider
 * feeds the *inline* indicators, which only ever track running deployments —
 * a finished one is dropped immediately so a bar can't sit frozen at a stale
 * percentage. Two subscribers to the same SSE endpoint is intentional and
 * cheap; the server fans out to a Set of listeners.
 */
const DeployProgressContext = createContext<Map<number, DeployProgress>>(new Map());

/** Exposed so tests can inject a fixed set of in-flight deployments. */
export { DeployProgressContext };

export function DeployProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<Map<number, DeployProgress>>(() => new Map());

  useEffect(() => {
    // Non-fatal by design: without EventSource the inline indicators simply
    // never appear — deployments themselves are entirely unaffected.
    let source: EventSource;
    try {
      source = new EventSource("/api/deployments/progress");
    } catch {
      return;
    }

    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          deployments: DeployProgress[];
        };
        const next = new Map<number, DeployProgress>();
        for (const deployment of data.deployments ?? []) {
          if (deployment.status === "running") {
            next.set(deployment.appId, deployment);
          }
        }
        setProgress(next);
      } catch {
        // A malformed frame is ignored rather than clearing live state.
      }
    });

    source.addEventListener("progress", (event) => {
      try {
        const deployment = JSON.parse((event as MessageEvent).data) as DeployProgress;
        setProgress((current) => {
          const next = new Map(current);
          if (deployment.status === "running") {
            next.set(deployment.appId, deployment);
          } else {
            // Succeeded/failed is the overlay's job to announce; drop it here
            // so the inline bar disappears the instant the work is done.
            next.delete(deployment.appId);
          }
          return next;
        });
      } catch {
        // As above.
      }
    });

    // The browser reconnects on its own; a transient drop is not a failure.
    source.addEventListener("error", () => {});

    return () => source.close();
  }, []);

  return (
    <DeployProgressContext.Provider value={progress}>{children}</DeployProgressContext.Provider>
  );
}

/** Every app currently deploying, keyed by appId. */
export function useDeployProgress(): Map<number, DeployProgress> {
  return useContext(DeployProgressContext);
}

/** The in-flight deployment for one app, or undefined when it isn't deploying. */
export function useAppDeployProgress(
  appId: number | null | undefined
): DeployProgress | undefined {
  const map = useDeployProgress();
  if (appId === null || appId === undefined) {
    return undefined;
  }
  return map.get(appId);
}
