"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ConsolePlanes } from "@/components/layout/console-planes";
import { AlertComposer } from "@/components/plan/alert-composer";
import { ReleaseSequence } from "@/components/plan/release-sequence";
import { EGRESS_EVENTS } from "@/components/shell/console-shell";
import { DataMissing } from "@/components/shell/data-missing";
import { ScenarioPicker } from "@/components/shell/scenario-picker";
import { BundleProvider, useBundle } from "@/lib/bundle-context";
import { bindingWave } from "@/lib/derive";
import { selLoadError, selScenarioId, useEgress } from "@/lib/store";
import type { ReleaseWave } from "@/types/egress";

/**
 * Preview harness for the split-plane console.
 *
 * Mounted at /planes. It exists because console-shell.tsx is owned by another
 * workflow this session and must not be edited from here: the two-line patch
 * that makes `/` render ConsolePlanes is reported, not applied, and this route
 * is how the layout is loaded, driven and screenshotted in the meantime.
 *
 * The modal plumbing below is a deliberate copy of the shell's, not a shared
 * module — sharing it would mean editing the shell. Delete this file once the
 * patch has landed and `/` renders the planes itself.
 */
export function PlanesPreview() {
  return (
    <BundleProvider>
      <PreviewBody />
    </BundleProvider>
  );
}

function PreviewBody() {
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
    <>
      <ConsolePlanes />

      {/* Modals stay window-centred over BOTH planes, so 980 > 960 never
          bites — the release panel is not constrained by the panel column. */}
      <Overlay open={releaseOpen} onClose={() => setReleaseOpen(false)} width={980}>
        <ReleaseSequence className="max-h-[88dvh]" />
      </Overlay>

      {composerWave ? (
        <AlertComposer wave={composerWave} onClose={() => setComposerWave(null)} />
      ) : null}

      <ScenarioPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </>
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
      <div className="relative flex w-full flex-col" style={{ maxWidth: width }}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-top-8 absolute right-0 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
        >
          Close
          <X size={13} strokeWidth={1.75} />
        </button>
        {children}
      </div>
    </div>
  );
}
