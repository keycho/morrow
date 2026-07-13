import type { Metadata } from "next";
import Link from "next/link";
import { DISCLAIMER, MARK } from "@/lib/constants";
import "./globals.css";

export const metadata: Metadata = {
  title: "fletch",
  description: "off-hours fair value for tokenized equities on robinhood chain",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="site-header">
            <Link href="/" className="logo">
              <span className="mark">{MARK}</span>fletch
            </Link>
            <nav className="nav">
              <Link href="/">feed</Link>
              <Link href="/spreads">spreads</Link>
              <Link href="/commits">commits</Link>
              <Link href="/status">status</Link>
              <Link href="/docs">docs</Link>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <div>{DISCLAIMER}</div>
            <div className="faint">
              {MARK} fletch. every published price is committed as a merkle root on robinhood
              chain and independently verifiable.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
