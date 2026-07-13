// web-side constants. the dashboard never imports server config; deployment
// urls arrive via NEXT_PUBLIC_* env vars (inlined at build time) and chain
// facts arrive inside api payloads. the disclaimer mirrors
// packages/config/config.ts and rides on every page footer.

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export const EXPLORER_URL = (process.env.NEXT_PUBLIC_EXPLORER_URL ?? "").replace(/\/$/, "");

export const DISCLAIMER =
  "informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.";

export const MARK = ">>--->";

export function txLink(txHash: string): string | null {
  if (!EXPLORER_URL) return null;
  return `${EXPLORER_URL}/tx/${txHash}`;
}

export function addressLink(address: string): string | null {
  if (!EXPLORER_URL) return null;
  return `${EXPLORER_URL}/address/${address}`;
}
