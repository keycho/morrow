// reads the public fletch api. the alert worker consumes the same /v1/spreads
// endpoint the dashboard uses; it never touches the database directly.

export interface SpreadRow {
  tokenId: number;
  symbol: string;
  name: string;
  fairValue: number;
  onchainSpot: number | null;
  spreadPct: number | null;
  confidence: number;
  regime: string;
  suspect: boolean;
  corporateAction: boolean;
  anchorStale: boolean;
  stale: boolean;
  cycleId: number;
  ts: string;
}

export async function fetchSpreads(apiUrl: string): Promise<SpreadRow[]> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/spreads`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`spreads api ${res.status}`);
  }
  const body = (await res.json()) as { data?: { rows?: SpreadRow[] } };
  return body.data?.rows ?? [];
}
