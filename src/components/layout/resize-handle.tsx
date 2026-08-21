"use client";

import { useCallback, useEffect, useRef } from "react";
import { cx } from "@/lib/format";

/**
 * The drag handle on a sheet's seam.
 *
 * Three things here are load-bearing.
 *
 * 1. POINTER EVENTS, NOT MOUSE EVENTS, and `setPointerCapture`. A mouse-only
 *    handler drops the drag the moment the cursor crosses the map canvas, which
 *    swallows pointer events for its own pan gesture — so the sheet would stick
 *    mid-resize exactly when the operator drags fast. Capture routes every move
 *    back here until release, regardless of what is underneath.
 *
 * 2. THE VISIBLE LINE IS 1px; THE HIT TARGET IS NOT. A 1px grab target is a
 *    game of pixel darts. The handle is 11px wide, centred on the seam with a
 *    negative margin so it does not shift the layout, and only its inner rule
 *    paints.
 *
 * 3. IT IS A KEYBOARD CONTROL. `role="separator"` with `aria-valuenow` and
 *    arrow keys, because a resize that only answers to a pointer is unusable
 *    for anyone who does not have one, and this one governs how much of the
 *    console you can see.
 *
 * useSemanticElements is switched off for this file in biome.json rather than
 * suppressed inline — a directive above a JSX attribute does not attach in
 * Biome 2.5.9. The rule wants <hr> for role="separator"; an <hr> is a static
 * divider with no focus and no aria-value*, so it cannot be a resizer, and
 * there is no native element that can.
 */

/** Px per arrow press; Shift multiplies. Small enough to tune, large enough to
 *  cross a 200px range without holding the key down for a minute. */
const NUDGE = 16;
const NUDGE_COARSE = 64;

export interface ResizeHandleProps {
  /** Current resolved width of the sheet this handle belongs to, in px. */
  width: number;
  min: number;
  max: number;
  /** Which side of the sheet the handle sits on. Governs the sign of a drag:
   *  dragging right widens a left-hand sheet and narrows a right-hand one. */
  edge: "right" | "left";
  onResize: (width: number) => void;
  /** Double-click clears the override and returns the sheet to its clamp. */
  onReset: () => void;
  label: string;
  className?: string;
}

export function ResizeHandle({
  width,
  min,
  max,
  edge,
  onResize,
  onReset,
  label,
  className,
}: ResizeHandleProps) {
  /* The drag origin lives in a ref, not state: it changes on every pointermove
     and a re-render per frame would be the whole cost of the feature. */
  const origin = useRef<{ x: number; width: number } | null>(null);

  const clamp = useCallback((n: number) => Math.round(Math.min(max, Math.max(min, n))), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons: a right-click here should open the browser's
    // menu, not start a drag that never gets a matching pointerup.
    if (e.button !== 0) return;
    origin.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current;
    if (!start) return;
    const delta = e.clientX - start.x;
    onResize(clamp(start.width + (edge === "right" ? delta : -delta)));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    origin.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? NUDGE_COARSE : NUDGE;
    // Arrow direction is spatial, not semantic: Left always moves the seam
    // left. Which sheet that widens depends on the edge, same as a drag.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const towardRight = e.key === "ArrowRight";
      const signed = (towardRight ? step : -step) * (edge === "right" ? 1 : -1);
      onResize(clamp(width + signed));
      e.preventDefault();
      return;
    }
    if (e.key === "Home") {
      onResize(min);
      e.preventDefault();
      return;
    }
    if (e.key === "End") {
      onResize(max);
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      onReset();
      e.preventDefault();
    }
  };

  /* While dragging, the whole document takes the resize cursor and stops
     selecting text. Without this the cursor flickers back to a caret the moment
     it leaves the 11px strip, which reads as the drag having been dropped. */
  const dragging = origin.current !== null;
  useEffect(() => {
    if (!dragging) return;
    const style = document.body.style;
    const prevCursor = style.cursor;
    const prevSelect = style.userSelect;
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = prevCursor;
      style.userSelect = prevSelect;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cx("resize-handle", edge === "right" ? "-right-[5px]" : "-left-[5px]", className)}
    >
      <span aria-hidden className="resize-handle-rule" />
    </div>
  );
}
