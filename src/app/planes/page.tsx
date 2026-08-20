import { PlanesPreview } from "@/components/layout/planes-preview";

/**
 * /planes — the split-plane console, mounted without touching the shell.
 *
 * console-shell.tsx is owned by another workflow this session, so the two-line
 * patch that makes `/` render <ConsolePlanes /> is reported rather than
 * applied. This route is how the new layout is loaded and verified until then;
 * it can be deleted the moment that patch lands.
 */
export default function PlanesPage() {
  return <PlanesPreview />;
}
