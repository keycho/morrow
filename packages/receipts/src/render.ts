// receipt rendering. pure. turns ReceiptData into a markdown summary and an
// svg card in the morrow instrument aesthetic (warm putty ground, ink text,
// one forest accent, hard edges, an offset hard shadow). the svg is rasterized
// to png separately; keeping it a plain string here makes rendering testable
// without any image dependency.

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

// morrow instrument palette (mirrors the web design tokens): warm putty ground,
// ink text, one forest accent, hard edges, an offset hard shadow. no gradients.
const COL = {
  ground: "#d7d1c2",
  surface: "#efeadd",
  band: "#ded8ca",
  ink: "#26231c",
  body: "#514b3f",
  dim: "#6f695b",
  faint: "#8a836f",
  hairline: "#bdb6a4",
  forest: "#38440d",
  forestItalic: "#56610f",
};

const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";

function tokenRowSvg(t: TokenReceipt, y: number): string {
  const err = fmtAbsPct(t.meanAbsErrorPct);
  const best = t.bestCall ? `${fmtAbsPct(Math.abs(t.bestCall.errorPct))} ${t.bestCall.date}` : "-";
  const errColor =
    t.meanAbsErrorPct === null
      ? COL.faint
      : t.meanAbsErrorPct < 0.5
        ? COL.forest
        : t.meanAbsErrorPct < 1.5
          ? COL.forestItalic
          : COL.ink;
  return [
    `<text x="46" y="${y}" fill="${COL.ink}" font-weight="600">${esc(t.symbol)}</text>`,
    `<text x="200" y="${y}" fill="${COL.dim}" text-anchor="end">${t.samples}</text>`,
    `<text x="392" y="${y}" fill="${errColor}" text-anchor="end" font-weight="600">${esc(err)}</text>`,
    `<text x="430" y="${y}" fill="${COL.body}">${esc(best)}</text>`,
  ].join("");
}

export function buildSvg(data: ReceiptData): string {
  const width = 820;
  const headerH = 132;
  const rowH = 30;
  const footerH = 108;
  const height = headerH + data.tokens.length * rowH + footerH;

  // card + offset hard shadow geometry.
  const cardX = 18;
  const cardY = 16;
  const cardW = width - 44;
  const cardH = height - 42;
  const shadow = 9;

  const rows = data.tokens
    .map((t, i) => tokenRowSvg(t, headerH + 26 + i * rowH))
    .join("\n  ");

  const tx = data.latestCommitTx ? data.latestCommitTx.slice(0, 14) + ".." : "none";
  const colY = headerH - 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${MONO}" font-size="15">
  <rect width="${width}" height="${height}" fill="${COL.ground}"/>
  <rect x="${cardX + shadow}" y="${cardY + shadow}" width="${cardW}" height="${cardH}" fill="${COL.ink}"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" fill="${COL.surface}" stroke="${COL.ink}" stroke-width="1.5"/>
  <rect x="${cardX}" y="${cardY}" width="4" height="${cardH}" fill="${COL.forest}"/>
  <text x="46" y="58" font-family="${SERIF}" font-weight="700" font-size="30" fill="${COL.ink}">morrow</text>
  <text x="182" y="58" fill="${COL.faint}" font-size="13">&gt;&gt;---&gt;</text>
  <text x="46" y="86" fill="${COL.body}" font-size="15">off-hours accuracy receipt</text>
  <text x="46" y="108" fill="${COL.dim}" font-size="13">week ${esc(data.weekStart)} to ${esc(data.weekEnd)}</text>
  <circle cx="${width - 44}" cy="52" r="5" fill="${COL.forest}"/>
  <text x="${width - 58}" y="56" text-anchor="end" fill="${COL.dim}" font-size="11">verified on-chain</text>
  <line x1="${cardX}" y1="${headerH}" x2="${cardX + cardW}" y2="${headerH}" stroke="${COL.hairline}"/>
  <text x="46" y="${colY}" fill="${COL.faint}" font-size="11">token</text>
  <text x="200" y="${colY}" fill="${COL.faint}" font-size="11" text-anchor="end">n</text>
  <text x="392" y="${colY}" fill="${COL.faint}" font-size="11" text-anchor="end">mean abs err</text>
  <text x="430" y="${colY}" fill="${COL.faint}" font-size="11">best call</text>
  ${rows}
  <line x1="${cardX}" y1="${height - footerH}" x2="${cardX + cardW}" y2="${height - footerH}" stroke="${COL.hairline}"/>
  <text x="46" y="${height - footerH + 30}" fill="${COL.ink}">cycles committed on-chain: ${data.cyclesCommitted}</text>
  <text x="46" y="${height - footerH + 52}" fill="${COL.forestItalic}">latest commit ${esc(tx)}</text>
  <text x="46" y="${height - 26}" fill="${COL.faint}" font-size="11">informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.</text>
</svg>`;
}
