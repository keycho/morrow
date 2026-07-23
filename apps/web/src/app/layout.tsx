import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "morrow · off-hours price oracle",
  description: "what a stock is worth when the market is closed. a verifiable off-hours fair value oracle for tokenized equities on solana.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="grain" aria-hidden="true" />
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
