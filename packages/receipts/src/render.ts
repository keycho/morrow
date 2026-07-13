// receipt rendering. pure. turns ReceiptData into a markdown summary and an
// svg card in the morrow terminal aesthetic (dark, monospace, arrow mark).
// the svg is rasterized to png separately; keeping it a plain string here
// makes rendering testable without any image dependency.

import type { ReceiptData, TokenReceipt } from "./types.js";

const DISCLAIMER =
  "informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.";

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(3)}%`;
}

function fmtAbsPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(3)}%`;
}

function fmtPrice(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- markdown ---------------------------------------------------------------

export function buildMarkdown(data: ReceiptData): string {
  const lines: string[] = [];
  lines.push(`# morrow weekly accuracy receipt`);
  lines.push("");
  lines.push(`\`>>--->\` week ${data.weekStart} to ${data.weekEnd}`);
  lines.push("");
  lines.push(`off-hours fair value vs the actual next-open print, per token.`);
  lines.push("");
  lines.push(`| token | samples | mean abs error | best call |`);
  lines.push(`| --- | ---: | ---: | --- |`);
  for (const t of data.tokens) {
    const best = t.bestCall
      ? `${fmtAbsPct(Math.abs(t.bestCall.errorPct))} on ${t.bestCall.date} (pred ${fmtPrice(t.bestCall.predicted)} vs ${fmtPrice(t.bestCall.actual)})`
      : "-";
    lines.push(
      `| ${t.symbol} | ${t.samples} | ${fmtAbsPct(t.meanAbsErrorPct)} | ${best} |`
    );
  }
  lines.push("");
  const txLink =
    data.latestCommitTx && data.explorerBaseUrl
      ? `[${data.latestCommitTx.slice(0, 10)}..](${data.explorerBaseUrl}/tx/${data.latestCommitTx})`
      : data.latestCommitTx
        ? data.latestCommitTx.slice(0, 10) + ".."
        : "none";
  lines.push(`cycles committed on-chain this week: ${data.cyclesCommitted}. latest commit: ${txLink}.`);
  lines.push("");
  lines.push(`_${DISCLAIMER}_`);
  return lines.join("\n");
}

// --- svg card ---------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const COL = {
  bg: "#0b0e11",
  panel: "#10151b",
  border: "#1d2733",
  text: "#c9d1d9",
  dim: "#7d8894",
  green: "#4ade80",
  cyan: "#67e8f9",
  amber: "#fbbf24",
};

function tokenRowSvg(t: TokenReceipt, y: number): string {
  const err = fmtAbsPct(t.meanAbsErrorPct);
  const best = t.bestCall ? `${fmtAbsPct(Math.abs(t.bestCall.errorPct))} ${t.bestCall.date}` : "-";
  const errColor =
    t.meanAbsErrorPct === null
      ? COL.dim
      : t.meanAbsErrorPct < 0.5
        ? COL.green
        : t.meanAbsErrorPct < 1.5
          ? COL.amber
          : COL.text;
  return [
    `<text x="40" y="${y}" fill="${COL.text}" font-weight="bold">${esc(t.symbol)}</text>`,
    `<text x="150" y="${y}" fill="${COL.dim}" text-anchor="end">${t.samples}</text>`,
    `<text x="330" y="${y}" fill="${errColor}" text-anchor="end">${esc(err)}</text>`,
    `<text x="360" y="${y}" fill="${COL.cyan}">${esc(best)}</text>`,
  ].join("");
}

export function buildSvg(data: ReceiptData): string {
  const width = 820;
  const headerH = 118;
  const rowH = 30;
  const footerH = 96;
  const height = headerH + data.tokens.length * rowH + footerH;

  const rows = data.tokens
    .map((t, i) => tokenRowSvg(t, headerH + 24 + i * rowH))
    .join("\n  ");

  const tx = data.latestCommitTx ? data.latestCommitTx.slice(0, 14) + ".." : "none";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="15">
  <rect width="${width}" height="${height}" fill="${COL.bg}"/>
  <rect x="16" y="16" width="${width - 32}" height="${height - 32}" fill="${COL.panel}" stroke="${COL.border}"/>
  <text x="40" y="52" fill="${COL.dim}">&gt;&gt;---&gt;</text>
  <text x="120" y="52" fill="${COL.green}" font-weight="bold" font-size="20">morrow</text>
  <text x="40" y="80" fill="${COL.text}" font-size="16">weekly accuracy receipt</text>
  <text x="40" y="102" fill="${COL.dim}">week ${esc(data.weekStart)} to ${esc(data.weekEnd)}</text>
  <line x1="24" y1="${headerH}" x2="${width - 24}" y2="${headerH}" stroke="${COL.border}"/>
  <text x="40" y="${headerH - 4}" fill="${COL.dim}" font-size="12">token</text>
  <text x="150" y="${headerH - 4}" fill="${COL.dim}" font-size="12" text-anchor="end">n</text>
  <text x="330" y="${headerH - 4}" fill="${COL.dim}" font-size="12" text-anchor="end">mean abs err</text>
  <text x="360" y="${headerH - 4}" fill="${COL.dim}" font-size="12">best call</text>
  ${rows}
  <line x1="24" y1="${height - footerH}" x2="${width - 24}" y2="${height - footerH}" stroke="${COL.border}"/>
  <text x="40" y="${height - footerH + 26}" fill="${COL.text}">cycles committed on-chain: ${data.cyclesCommitted}</text>
  <text x="40" y="${height - footerH + 48}" fill="${COL.cyan}">latest commit ${esc(tx)}</text>
  <text x="40" y="${height - 22}" fill="${COL.dim}" font-size="11">informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.</text>
</svg>`;
}
