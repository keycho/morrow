"use client";

export function RegimeBadge({ regime }: { regime: string }) {
  return <span className={`badge ${regime}`}>{regime.replace("_", " ")}</span>;
}

export function SuspectBadge({ suspect }: { suspect: boolean }) {
  if (!suspect) return null;
  return (
    <span className="badge suspect" title="onchain move beyond the spike threshold with flat proxies; output clamped to the band edge">
      suspect
    </span>
  );
}
