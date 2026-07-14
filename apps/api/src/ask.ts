// the /v1/ask intent parser. deliberately bounded: no model, no speculation,
// no free text generation. it maps a natural-language question onto one of four
// things morrow can answer from its own data (fair value, spread, accuracy, a
// commit) for one tracked token, or it refuses. refusal is a first-class result
// with a plain reason, never a guess. this file is pure and unit-tested; the
// route does the data lookup and stitches on provenance.

export type AskKind = "fair_value" | "spread" | "accuracy" | "commit";

export interface AskToken {
  symbol: string; // lowercase
  aliases: string[]; // lowercase words that also name the token, e.g. "tesla"
}

export interface AskIntent {
  kind: AskKind;
  symbol: string;
}

export type AskRefusalReason = "empty" | "advice" | "no_token" | "too_long";

export type AskParse =
  | { ok: true; intent: AskIntent }
  | { ok: false; reason: AskRefusalReason; message: string };

const MAX_LEN = 280;

// clear advice / prediction / speculation language. if any appears, morrow
// refuses: it reports data, it does not tell anyone what to do or what will
// happen. kept broad on purpose; a false refusal is safe, a stray tip is not.
const ADVICE_MARKERS = [
  "should i",
  "should we",
  "shall i",
  "worth buying",
  "worth selling",
  "good buy",
  "good investment",
  "good time to",
  "buy",
  "sell",
  "invest",
  "moon",
  "will it",
  "will tsla",
  "going to",
  "gonna",
  "predict",
  "prediction",
  "forecast",
  "price target",
  "target price",
  "go up",
  "go down",
  "pump",
  "dump",
  "get rich",
  "make money",
  "recommend",
  "should you",
];

// intent keyword sets, checked most specific first.
const COMMIT_MARKERS = [
  "commit",
  "verify",
  "verified",
  "verifiable",
  "proof",
  "merkle",
  "root",
  "on-chain",
  "onchain",
  "on chain",
  "hash",
  "provable",
  "prove",
];
const ACCURACY_MARKERS = [
  "accura",
  "error",
  "track record",
  "how good",
  "how well",
  "reliable",
  "median",
  "hit rate",
  "backtest",
  "beat naive",
];
const SPREAD_MARKERS = [
  "spread",
  "mispric",
  "vs pool",
  "pool price",
  "pool",
  "premium",
  "discount",
  "overvalued",
  "undervalued",
  "above fair",
  "below fair",
  "divergence",
  "trading above",
  "trading below",
];
const FAIR_MARKERS = [
  "worth",
  "fair value",
  "fair-value",
  "value of",
  "price of",
  "how much",
  "what is",
  "what's",
  "whats",
  "quote",
  "valuation",
  "price",
];

function has(text: string, markers: string[]): boolean {
  return markers.some((m) => text.includes(m));
}

// find a tracked token by symbol or alias as a whole word.
function findToken(text: string, tokens: AskToken[]): string | null {
  for (const t of tokens) {
    const needles = [t.symbol, ...t.aliases];
    for (const n of needles) {
      const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (re.test(text)) return t.symbol;
    }
  }
  return null;
}

const TOKEN_LIST = (tokens: AskToken[]): string => tokens.map((t) => t.symbol).join(", ");

export function parseAsk(question: string, tokens: AskToken[]): AskParse {
  const raw = (question ?? "").trim();
  if (raw === "") {
    return { ok: false, reason: "empty", message: "ask a question about a tracked token." };
  }
  if (raw.length > MAX_LEN) {
    return {
      ok: false,
      reason: "too_long",
      message: "that question is too long. ask something short about a tracked token.",
    };
  }
  const text = raw.toLowerCase();

  if (has(text, ADVICE_MARKERS)) {
    return {
      ok: false,
      reason: "advice",
      message:
        "morrow reports data, not trading advice or predictions. ask what a token is worth, its spread, its accuracy, or its latest commit.",
    };
  }

  const symbol = findToken(text, tokens);
  if (!symbol) {
    return {
      ok: false,
      reason: "no_token",
      message: `morrow only answers about its tracked tokens: ${TOKEN_LIST(tokens)}. name one.`,
    };
  }

  // most specific intent first; fair value is the default for a bare token.
  const kind: AskKind = has(text, COMMIT_MARKERS)
    ? "commit"
    : has(text, ACCURACY_MARKERS)
      ? "accuracy"
      : has(text, SPREAD_MARKERS)
        ? "spread"
        : "fair_value";

  return { ok: true, intent: { kind, symbol } };
}
