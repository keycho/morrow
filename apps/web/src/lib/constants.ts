// web-side constants. the dashboard never imports server config; deployment
// urls arrive via NEXT_PUBLIC_* env vars (inlined at build time) and chain
// facts arrive inside api payloads. the disclaimer mirrors
// packages/config/config.ts and rides on every page footer.

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export const EXPLORER_URL = (process.env.NEXT_PUBLIC_EXPLORER_URL ?? "").replace(/\/$/, "");

// chain read config for the client-side verify path and the explorer's
// contract-read commit count. deployment config (public), env-overridable.
// the public rpc is rate limited but fine for occasional read-only verifies.
export const RPC_URL = (
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
).replace(/\/$/, "");

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "4663");

// the deployed MorrowCommits address. set NEXT_PUBLIC_COMMITS_ADDRESS per
// deployment. empty string means the on-chain commit count is unavailable and
// the ui says so plainly rather than inventing a number.
export const COMMITS_ADDRESS = (process.env.NEXT_PUBLIC_COMMITS_ADDRESS ?? "").trim();

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
