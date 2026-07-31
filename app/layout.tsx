import type { Metadata } from "next";
import "./globals.css";

// System font stack per 06-FRONTEND-SPEC.md §2 — no webfont request on a dense internal tool.
export const metadata: Metadata = {
  title: "trysearch — ASO console",
  description: "Keyword research, daily rank tracking and listing optimisation from free public store data.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
