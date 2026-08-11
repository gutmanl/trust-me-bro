import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "TrustMeBro",
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
          <div className="mx-auto flex max-w-5xl items-baseline gap-4 px-6 py-4">
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
