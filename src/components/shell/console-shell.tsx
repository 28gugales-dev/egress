"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ConsolePlanes } from "@/components/layout/console-planes";
import { AlertComposer } from "@/components/plan/alert-composer";
import { ReleaseSequence } from "@/components/plan/release-sequence";
import { DataMissing } from "@/components/shell/data-missing";
import { ScenarioPicker } from "@/components/shell/scenario-picker";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { BundleProvider, useBundle } from "@/lib/bundle-context";
import { bindingWave } from "@/lib/derive";
import { selLoadError, selScenarioId, useEgress } from "@/lib/store";
import type { ReleaseWave } from "@/types/egress";

/**
 * Cross-panel commands travel as window CustomEvents rather than prop drilling.
 * The rails, inspector and map are owned by different modules; a DOM event is
 * the one channel all of them already share without importing each other.
 *
 * `egress:flyto` is deliberately absent: MapShell owns that bus itself
 * (EGRESS_FLYTO_EVENT / flyTo in components/map/map-shell), and a second
 * listener here would fight it for the camera.
 */
export const EGRESS_EVENTS = {
  openScenarios: "egress:open-scenarios",
  openReleaseSequence: "egress:open-release-sequence",
  openAlertComposer: "egress:open-alert-composer",
} as const;

/* Emitters, so a rail or inspector button never has to hand-roll a CustomEvent
   and drift on the name. Safe to call from any client component. */
function emit(name: string, detail?: unknown) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/* Function declarations, not const arrows: a rail module importing these while
   the shell imports the rail is a module cycle, and only hoisted bindings
   survive one. Nothing here runs at module-eval time. */
export function openScenarioPicker() {
  emit(EGRESS_EVENTS.openScenarios);
}
export function openReleaseSequence() {
  emit(EGRESS_EVENTS.openReleaseSequence);
}
/** Omit the wave and the shell composes for the wave that binds clearance. */
export function openAlertComposer(wave?: ReleaseWave) {
  emit(EGRESS_EVENTS.openAlertComposer, wave ? { wave } : undefined);
}

export function ConsoleShell() {
  return (
    <BundleProvider>
      <ConsoleBody />
    </BundleProvider>
  );
}

function ConsoleBody() {
  const loadError = useEgress(selLoadError);
  const scenarioId = useEgress(selScenarioId);
  const bundle = useBundle();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [composerWave, setComposerWave] = useState<ReleaseWave | null>(null);

  useEffect(() => {
    const openPicker = () => setPickerOpen(true);
    const openRelease = () => {
      setComposerWave(null);
      setReleaseOpen(true);
    };
    const openAlerts = (e: Event) => {
      const detail = (e as CustomEvent<{ wave?: ReleaseWave }>).detail;
      const plan = bundle?.planned?.plan ?? null;
      const wave = detail?.wave ?? bindingWave(plan) ?? plan?.waves[0] ?? null;
      // No plan means nothing to alert on. Show the sequence panel's own empty
      // state rather than a composer with no wave behind it.
      if (!wave) {
        setReleaseOpen(true);
        return;
      }
      setReleaseOpen(false);
      setComposerWave(wave);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPickerOpen(false);
      setReleaseOpen(false);
      setComposerWave(null);
    };

    window.addEventListener(EGRESS_EVENTS.openScenarios, openPicker);
    window.addEventListener(EGRESS_EVENTS.openReleaseSequence, openRelease);
    window.addEventListener(EGRESS_EVENTS.openAlertComposer, openAlerts);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(EGRESS_EVENTS.openScenarios, openPicker);
      window.removeEventListener(EGRESS_EVENTS.openReleaseSequence, openRelease);
      window.removeEventListener(EGRESS_EVENTS.openAlertComposer, openAlerts);
      window.removeEventListener("keydown", onKey);
    };
  }, [bundle]);

  if (loadError) return <DataMissing error={loadError} scenarioId={scenarioId} />;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Everything that composes the console lives in ConsolePlanes: the map
          plane, the panel column beside it, the loading veil and the map key,
          which is now anchored into the map's own bottom bezel rather than
          fixed to the window. This shell keeps only what is genuinely above the
          layout -- the event bus, the load-failure branch, and the modals,
          which stay window-centred over BOTH planes rather than over one. */}
      <ConsolePlanes />

      <Overlay open={releaseOpen} onClose={() => setReleaseOpen(false)} width={980}>
        <ReleaseSequence className="max-h-[88dvh]" />
      </Overlay>

      {/* AlertComposer brings its own backdrop, so it is mounted bare. */}
      {composerWave ? (
        <AlertComposer wave={composerWave} onClose={() => setComposerWave(null)} />
      ) : null}

      <ScenarioPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

function Overlay({
  open,
  onClose,
  width,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[rgba(4,6,9,0.5)]"
      />
      {/* The first attempt at this wrap failed, and the fix was not here: the
          panels mounted inside bring their own opaque .glass, which repainted
          the dark deck straight back in and left the wrapper showing as a pale
          strip above a dark panel. globals.css now re-binds the whole token set
          under .lg-surface, so a nested .glass paints nothing and every utility
          in those 1,700 lines resolves to the light palette untouched. */}
      <LiquidGlass
        radius="lg"
        className="relative flex w-full flex-col overflow-hidden"
        style={{ maxWidth: width }}
      >
        {children}
      </LiquidGlass>
      {/* Dismiss sits outside the sheet: the panels mounted here own their own
          headers and there is no slot to inject one into. Absolute against the
          same centring box, so it tracks the sheet at any width. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        className="absolute top-6 right-6 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
      >
        Close
        <X size={13} strokeWidth={1.75} />
      </button>
    </div>
  );
}
