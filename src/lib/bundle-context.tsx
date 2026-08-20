"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { isLoadError, loadScenario, peekScenario, type ScenarioBundle } from "@/lib/data";
import { actions, selScenarioId, useEgress } from "@/lib/store";

/**
 * The loaded bundle is the one piece of state that genuinely belongs in
 * context: it changes only when the scenario changes, so a provider re-render
 * costs nothing. Everything that moves per frame stays in the external store.
 */

const BundleContext = createContext<ScenarioBundle | null>(null);

export function BundleProvider({ children }: { children: ReactNode }) {
  const scenarioId = useEgress(selScenarioId);
  const [loaded, setLoaded] = useState<{ id: string; bundle: ScenarioBundle | null }>(() => ({
    id: scenarioId,
    bundle: peekScenario(scenarioId),
  }));

  useEffect(() => {
    // Already resident: swap synchronously so returning to a scenario does not
    // flash the loading shell.
    const cached = peekScenario(scenarioId);
    if (cached) {
      setLoaded({ id: scenarioId, bundle: cached });
      actions.setLoading(false);
      return;
    }

    let cancelled = false;
    setLoaded({ id: scenarioId, bundle: null });
    actions.setLoading(true);

    loadScenario(scenarioId)
      .then((bundle) => {
        if (cancelled) return;
        setLoaded({ id: scenarioId, bundle });
        actions.setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ id: scenarioId, bundle: null });
        actions.setLoading(false, describe(scenarioId, err));
      });

    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  // Never hand out the previous scenario's bundle while the next one loads.
  const value = loaded.id === scenarioId ? loaded.bundle : null;

  return <BundleContext.Provider value={value}>{children}</BundleContext.Provider>;
}

/** Null while loading or after a load failure. Use in anything that renders
 *  before the payloads land. */
export function useBundle(): ScenarioBundle | null {
  return useContext(BundleContext);
}

/** For components mounted behind the loading gate, where a null bundle is a bug. */
export function useBundleOrThrow(): ScenarioBundle {
  const bundle = useContext(BundleContext);
  if (!bundle) {
    throw new Error(
      "useBundleOrThrow called with no scenario loaded — render this behind the loading gate, or use useBundle().",
    );
  }
  return bundle;
}

function describe(scenarioId: string, err: unknown): string {
  if (isLoadError(err)) return err.message;
  if (err instanceof Error) return `Could not load scenario "${scenarioId}": ${err.message}`;
  return `Could not load scenario "${scenarioId}".`;
}
