import { describe, expect, it } from "vitest";
import { lastCompletedWeek } from "../src/week.js";
import { buildMarkdown, buildSvg } from "../src/render.js";
import type { ReceiptData } from "../src/types.js";

describe("lastCompletedWeek", () => {
  it("reports the prior week when run on a monday", () => {
    // monday 2026-07-20 -> prior week mon 07-13 to fri 07-17
    expect(lastCompletedWeek(2026, 7, 20)).toEqual({
      weekStart: "2026-07-13",
      weekEnd: "2026-07-17",
    });
  });

  it("reports the most recently completed week midweek", () => {
    // wednesday 2026-07-22 -> last completed week is 07-13 to 07-17
    expect(lastCompletedWeek(2026, 7, 22)).toEqual({
      weekStart: "2026-07-13",
      weekEnd: "2026-07-17",
    });
  });

  it("handles a month boundary", () => {
    // monday 2026-08-03 -> prior week mon 07-27 to fri 07-31
    expect(lastCompletedWeek(2026, 8, 3)).toEqual({
      weekStart: "2026-07-27",
      weekEnd: "2026-07-31",
    });
  });
});

const sample: ReceiptData = {
  weekStart: "2026-07-13",
  weekEnd: "2026-07-17",
  generatedAt: "2026-07-20T13:30:00.000Z",
  explorerBaseUrl: "https://explorer.example",
  tokens: [
    {
      symbol: "tsla",
      name: "tesla",
      samples: 5,
      meanAbsErrorPct: 0.412,
      bestCall: { date: "2026-07-15", predicted: 250.1, actual: 250.2, errorPct: -0.04 },
    },
    { symbol: "nvda", name: "nvidia", samples: 0, meanAbsErrorPct: null, bestCall: null },
  ],
  cyclesCommitted: 812,
  latestCommitTx: "0xabc1234567890def",
  latestCommitCycle: 2950123,
};

describe("markdown rendering", () => {
  it("includes the week, tokens, and commit total", () => {
    const md = buildMarkdown(sample);
    expect(md).toContain("2026-07-13 to 2026-07-17");
    expect(md).toContain("tsla");
    expect(md).toContain("0.412%");
    expect(md).toContain("cycles committed on-chain this week: 812");
    expect(md).toContain("explorer.example/tx/0xabc1234567890def");
    // lowercase, no exclamation marks
    expect(md).not.toContain("!");
  });

  it("renders a dash for a token with no samples", () => {
    const md = buildMarkdown(sample);
    expect(md).toMatch(/nvda \| 0 \| - \| -/);
  });
});

describe("svg rendering", () => {
  it("produces a valid svg with the arrow mark and data", () => {
    const svg = buildSvg(sample);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("fletch");
    expect(svg).toContain("&gt;&gt;---&gt;"); // escaped arrow mark
    expect(svg).toContain("tsla");
    expect(svg).toContain("cycles committed on-chain: 812");
    expect(svg).not.toContain("!");
  });

  it("escapes and never emits a raw unescaped angle bracket in text", () => {
    const svg = buildSvg(sample);
    // the only < and > should be tag delimiters or escaped entities
    const withoutTags = svg.replace(/<[^>]+>/g, "");
    expect(withoutTags).not.toContain("<");
  });
});
