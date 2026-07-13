// alert message formatting. lowercase, terminal style, data statements only,
// no financial advice language. a single configured footer disclaims.

import type { SpreadRow } from "./client.js";

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAlert(row: SpreadRow, webUrl: string, footer: string): string {
  const spread = row.spreadPct ?? 0;
  const arrow = spread > 0 ? "^" : spread < 0 ? "v" : "=";
  const sign = spread > 0 ? "+" : "";
  const link = webUrl ? `${webUrl.replace(/\/$/, "")}/token/${row.symbol}` : `token ${row.symbol}`;
  const regime = row.regime.replace("_", " ");
  return [
    `${row.symbol} ${arrow} ${sign}${spread.toFixed(2)}%`,
    `fair value ${fmt(row.fairValue)}  pool ${fmt(row.onchainSpot)}`,
    `confidence ${row.confidence}  regime ${regime}`,
    link,
    footer,
  ].join("\n");
}
