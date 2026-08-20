import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { GlassFilter } from "@/components/ui/liquid-glass";
import "@/app/globals.css";

/* globals.css reads these two variable names directly in --font-sans /
   --font-mono, so the names here are load-bearing, not cosmetic. */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-jb",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Egress",
  description: "Capacity-constrained evacuation planning at incident tempo.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  colorScheme: "dark",
  themeColor: "#07090c",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* Mounted once at the root: an SVG filter is referenced by id, so a
            per-modal copy would collide on `#lg-refract` and only the first
            would resolve. */}
        <GlassFilter />
        {children}
      </body>
    </html>
  );
}
