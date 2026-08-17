import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

/**
 * `template` rather than a bare string: every route sets its own title and
 * composes it with this one, so several open tabs are distinguishable. A
 * project's segment overrides the template again with the research question
 * (see `app/projects/[id]/layout.tsx`), which is what actually tells two
 * project tabs apart.
 */
export const metadata: Metadata = {
  title: { default: "TrustMeBro", template: "%s · TrustMeBro" },
  description: "Verifikations-Werkstatt für recherchierte Briefings",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de">
      {/* overflow-x-clip: the review workspace breaks out to viewport width
          with 50vw margins; 100vw includes the scrollbar, so without the
          clip a few pixels of horizontal scroll appear. */}
      <body className="min-h-screen overflow-x-clip bg-slate-50 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          {/* The wide bound, not `max-w-5xl` like <main>: the project
              workspace breaks out past 5xl, and a chrome bar narrower than
              the content beneath it reads as a broken layout. Wider than a
              reading column does not. */}
          <div className="mx-auto flex max-w-[110rem] items-baseline gap-4 px-6 py-4">
            <Link
              href="/projects"
              className="text-lg font-semibold tracking-tight"
            >
              TrustMeBro
            </Link>
            <span className="text-sm text-slate-500">
              Verifikations-Werkstatt
            </span>
            <Link
              href="/settings"
              className="ml-auto text-sm text-slate-500 hover:text-slate-700"
            >
              Einstellungen
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
