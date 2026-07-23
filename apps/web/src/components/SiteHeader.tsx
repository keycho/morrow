"use client";

// interior nav header used on every page except the landing. wordmark + the
// active section label, the six nav links (explorer routes to /commits), and
// the live regime pill. active section is derived from the route.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DEMO } from "@/lib/constants";
import { RegimePill } from "./RegimePill";

interface NavItem {
  label: string;
  href: string;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { label: "feed", href: "/feed", match: (p) => p === "/feed" || p.startsWith("/token") },
  { label: "spreads", href: "/spreads", match: (p) => p.startsWith("/spreads") },
  ...(DEMO
    ? [{ label: "perps", href: "/perps", match: (p: string) => p.startsWith("/perps") }]
    : []),
  { label: "explorer", href: "/commits", match: (p) => p.startsWith("/commits") },
  { label: "receipts", href: "/receipts", match: (p) => p.startsWith("/receipts") },
  { label: "docs", href: "/docs", match: (p) => p.startsWith("/docs") },
  { label: "status", href: "/status", match: (p) => p.startsWith("/status") },
];

export function SiteHeader() {
  const pathname = usePathname() ?? "/feed";
  const active = NAV.find((n) => n.match(pathname));

  return (
    <header className="site-header">
      <Link href="/" className="wordmark">
        morrow
        {active && <span className="sub">/ {active.label.toUpperCase()}</span>}
      </Link>
      <nav className="nav">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={n === active ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <RegimePill />
    </header>
  );
}
