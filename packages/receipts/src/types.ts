// receipt data shapes. the renderer turns these into markdown and an svg
// card; the data layer builds them from the database.

export interface TokenReceipt {
  symbol: string;
  name: string;
  // number of open prints that had a matching pre-open fair value this week.
  samples: number;
  // mean absolute error percent between the pre-open fair value and the open.
  meanAbsErrorPct: number | null;
  // the single most accurate call of the week.
  bestCall: {
    date: string;
    predicted: number;
    actual: number;
    errorPct: number;
  } | null;
}

export interface ReceiptData {
  // monday of the reported (just-completed) week, yyyy-mm-dd.
  weekStart: string;
  // friday of the reported week, yyyy-mm-dd.
  weekEnd: string;
  generatedAt: string;
  explorerBaseUrl: string;
  tokens: TokenReceipt[];
  // commits are per-cycle (cover all tokens), so these are week totals.
  cyclesCommitted: number;
  latestCommitTx: string | null;
  latestCommitCycle: number | null;
}
