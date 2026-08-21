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
 * 2. THESE SURFACES ARE LIGHT, AND THE REST OF THE CONSOLE IS DARK.
 *    Black ink needs a light ground, so a liquid-glass modal is frosted white
 *    over the dark instrument rather than another dark pane. That flips the
 *    contrast contract for anything drawn inside it: the hazard/plan/warn hues
 *    and the five zone-status hues are all tuned for a dark ground and go
 *    muddy on this one. Use the `--lg-*` data hues from globals.css inside a
 *    liquid-glass surface, never the raw dark-ground tokens.
 */

/** Radius scale. Modals sit at `lg`; controls inside them step down. */
const RADIUS = {
  sm: "rounded-[8px]",
  md: "rounded-[12px]",
  lg: "rounded-[18px]",
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

/**
 * Padding and type size, as a named register rather than a className override.
 *
 * A prop, and it has to be: the base class list below hardcodes `px-4 py-2
 * text-[13px]`, and Tailwind emits every utility it sees into ONE sheet whose
 * source order decides which of two competing declarations wins — the order of
 * the names in the `class` attribute has no effect at all. So a caller passing
 * `px-2.5 py-1.5 text-[11.5px]` in `className` got a 13px button with 16px
 * padding and no error anywhere, which is exactly what the release sequence's
 * action row was doing: it truncated its own labels at a 440px sheet while its
 * source said it was compact.
 */
const SIZE = {
  md: "px-4 py-2 text-[13px]",
  /** For a control row inside a dense pane rather than a modal's footer. */
  sm: "px-2.5 py-1.5 text-[11.5px]",
} as const;

export type GlassButtonSize = keyof typeof SIZE;

interface LiquidButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  radius?: GlassRadius;
  size?: GlassButtonSize;
  /** `primary` is the one action a panel wants you to take. At most one. */
  tone?: "default" | "primary" | "quiet";
  /**
   * Which ground the button sits on. Stated, not inferred: the same button is
   * used inside a light liquid-glass modal and on the dark instrument deck, and
   * a control cannot see its own backdrop. Getting it wrong is not cosmetic --
   * `primary` on a light surface is a near-black pill, and that pill on the
   * dark deck disappears into it.
   */
  ground?: "light" | "dark";
  children?: ReactNode;
}

export function LiquidButton({
  radius = "pill",
  size = "md",
  tone = "default",
  ground = "light",
  className,
  children,
  ...rest
}: LiquidButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "lg-button relative isolate inline-flex cursor-pointer items-center justify-center gap-2",
        "whitespace-nowrap font-medium transition-[transform,filter] duration-200",
        SIZE[size],
        "hover:brightness-[1.04] active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
        RADIUS[radius],
        ground === "dark" && "lg-button-on-dark",
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
      {/* min-w-0 so a caller can hand this a truncating label. Without it the
          inner flex line has an automatic minimum size equal to its content and
          `truncate` on a child is inert, which is how a fixed-width button ends
          up wider than the cell it was placed in. */}
      <span className="pointer-events-none z-10 inline-flex min-w-0 items-center gap-2">
        {children}
      </span>
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
