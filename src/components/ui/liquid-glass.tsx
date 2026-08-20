"use client";

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "@/lib/format";

/**
 * Liquid glass — refractive surfaces for modals and their controls.
 *
 * Two things here are load-bearing and easy to get wrong later.
 *
 * 1. THE REFRACTION IS PROGRESSIVE ENHANCEMENT, NOT THE EFFECT.
 *    `backdrop-filter: url(#…)` — an SVG filter referenced from a backdrop —
 *    is Chromium-only, and inconsistent even there. Safari and Firefox drop it
 *    silently. So the glass never *depends* on it: the layered inset highlights
 *    and the blur/saturate stack below carry the whole look on their own, and
 *    the displacement map is an extra that some browsers get. Check any change
 *    here with the filter forced off before assuming it still reads.
 *
 * 2. THESE SURFACES ARE SMOKED, NOT FROSTED.
 *    A dark tint at roughly half alpha, so the map underneath stays legible
 *    through the pane — which is the only reason to put a surface over live
 *    geography at all. A near-white tint was tried first and reads as paper
 *    laid on the map: past about 60% alpha the ground stops coming through and
 *    the rim has nothing to find an edge against.
 *
 *    The consequence is a good one. Because the tint is dark, the deck's own
 *    hazard/plan/warn and five zone-status hues are already correct inside a
 *    liquid-glass surface, so a panel mounted on glass looks like itself and
 *    nothing has to be re-tuned. globals.css still re-binds the token set at
 *    .lg-surface, but now it is re-binding dark onto dark — the values change
 *    for translucency, not for contrast polarity.
 */

/** Radius scale. Modals sit at `lg`; controls inside them step down. */
const RADIUS = {
  sm: "rounded-[8px]",
  md: "rounded-[12px]",
  lg: "rounded-[18px]",
  /** A sheet flush to one window edge: only the edge facing the map is turned.
   *  Rounding the flush side would open a sliver of map at the window corner. */
  right: "rounded-r-[18px]",
  pill: "rounded-full",
} as const;

export type GlassRadius = keyof typeof RADIUS;

interface LiquidGlassProps extends HTMLAttributes<HTMLDivElement> {
  radius?: GlassRadius;
  /** Declared explicitly: HTMLAttributes does not carry `ref`, and a modal that
   *  moves focus to its own sheet needs one. React 19 passes it as a plain prop. */
  ref?: Ref<HTMLDivElement>;
  /** Turns the refraction off for surfaces sitting over busy imagery, where
   *  displacement reads as a rendering fault rather than as glass. */
  refract?: boolean;
  children?: ReactNode;
}

export function LiquidGlass({
  radius = "lg",
  refract = true,
  className,
  children,
  ref,
  ...rest
}: LiquidGlassProps) {
  return (
    <div
      ref={ref}
      className={cx("lg-surface relative isolate", RADIUS[radius], className)}
      {...rest}
    >
      {/* Refraction plane. Sits behind content, never intercepts a pointer. */}
      {refract ? (
        <div
          aria-hidden
          className={cx("pointer-events-none absolute inset-0 -z-10", RADIUS[radius])}
          style={{ backdropFilter: "url(#lg-refract)" }}
        />
      ) : null}
      {/* Specular rim. A single element so the highlight cannot drift out of
          register with the surface when the radius changes. */}
      <div
        aria-hidden
        className={cx("lg-rim pointer-events-none absolute inset-0", RADIUS[radius])}
      />
      {children}
    </div>
  );
}

interface LiquidButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  radius?: GlassRadius;
  /** `primary` is the one action a panel wants you to take. At most one. */
  tone?: "default" | "primary" | "quiet";
  children?: ReactNode;
}

export function LiquidButton({
  radius = "pill",
  tone = "default",
  className,
  children,
  ...rest
}: LiquidButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "lg-button relative isolate inline-flex cursor-pointer items-center justify-center gap-2",
        "whitespace-nowrap px-4 py-2 font-medium text-[13px] transition-[transform,filter] duration-200",
        "hover:brightness-[1.04] active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
        RADIUS[radius],
        tone === "primary" && "lg-button-primary",
        tone === "quiet" && "lg-button-quiet",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cx("lg-rim pointer-events-none absolute inset-0", RADIUS[radius])}
      />
      <span className="pointer-events-none z-10 inline-flex items-center gap-2">{children}</span>
    </button>
  );
}

/**
 * The displacement filter, mounted once near the app root.
 *
 * `scale` is deliberately small. The reference implementation of this effect
 * uses 70, which bends text into illegibility — fine over a photograph, wrong
 * under a table of numbers an operator has to read. 12 reads as thick glass at
 * the rim and leaves the middle of the panel flat.
 */
export function GlassFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0" focusable="false">
      <title>Liquid glass refraction filter</title>
      <defs>
        <filter
          id="lg-refract"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.012"
            numOctaves="2"
            seed="4"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="3" result="softNoise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="softNoise"
            scale="12"
            xChannelSelector="R"
            yChannelSelector="B"
            result="displaced"
          />
          <feGaussianBlur in="displaced" stdDeviation="0.4" />
        </filter>
      </defs>
    </svg>
  );
}
