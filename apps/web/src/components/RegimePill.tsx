"use client";

// live regime pill for the header. reads the client-side et market clock and
// re-renders every second so the countdown to the next open stays live. the
// authoritative regime still rides on every published price; this is the
// lightweight header convenience only.

import { useEffect, useState } from "react";
import {
  regimeNow,
  regimeLabel,
  secsToNextOpen,
  nextOpenDay,
  fmtCountdown,
} from "@/lib/marketClock";

export function RegimePill({ showCountdown = false }: { showCountdown?: boolean }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // render nothing time-specific until mounted, to avoid a hydration mismatch.
  if (!now) {
    return <span className="regime-pill" suppressHydrationWarning />;
  }

  const regime = regimeNow(now);
  const label = regimeLabel(regime).toUpperCase();

  return (
    <span className="regime-pill" suppressHydrationWarning>
      <span className="dot" />
      {label}
      {showCountdown && regime !== "market_open" && (
        <>
          {" · OPENS "}
          {fmtCountdown(secsToNextOpen(now))}
        </>
      )}
    </span>
  );
}

export function nextOpenLabel(now: Date): string {
  return `next open ${nextOpenDay(now)} 09:30 et`;
}
