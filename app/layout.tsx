import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TrustMeBro",
  description: "Verifikations-Werkstatt für recherchierte Briefings",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
