import type { Metadata } from "next";
import Link from "next/link";
import { DISCLAIMER, MARK } from "@/lib/constants";
import "./globals.css";

export const metadata: Metadata = {
  title: "morrow",
  description: "what stocks are worth when the market is closed",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="site-header">
            <Link href="/" className="logo">
              <span className="mark">{MARK}</span>morrow
            </Link>
            <nav className="nav">
              <Link href="/">feed</Link>
              <Link href="/spreads">spreads</Link>
              <Link href="/commits">commits</Link>
              <Link href="/receipts">receipts</Link>
              <Link href="/status">status</Link>
              <Link href="/docs">docs</Link>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <div>{DISCLAIMER}</div>
            <div className="faint">
              {MARK} morrow. every published price is committed as a merkle root on robinhood
              chain and independently verifiable.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
