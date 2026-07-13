import { describe, expect, it } from "vitest";
import { evaluate, initialState, type AlertConfig } from "../src/alertlogic.js";

const cfg: AlertConfig = { thresholdPct: 2, rearmFraction: 0.5, cooldownMs: 30 * 60_000 };
const T0 = 1_000_000;

describe("divergence alert logic", () => {
  it("fires on the first crossing from armed", () => {
    const { alert, state } = evaluate(initialState(), 2.3, cfg, T0);
    expect(alert).toBe(true);
    expect(state.armed).toBe(false);
    expect(state.lastAlertMs).toBe(T0);
  });

  it("does not re-fire while it stays above threshold (disarmed)", () => {
    const first = evaluate(initialState(), 2.3, cfg, T0);
    const second = evaluate(first.state, 2.6, cfg, T0 + 60_000);
    expect(second.alert).toBe(false);
    expect(second.state.armed).toBe(false);
  });

  it("stays disarmed in the hysteresis band (below threshold, above rearm)", () => {
    const first = evaluate(initialState(), 2.3, cfg, T0);
    // 1.2% is below the 2% threshold but above the 1% re-arm line
    const mid = evaluate(first.state, 1.2, cfg, T0 + 60_000);
    expect(mid.state.armed).toBe(false);
    // re-crossing without re-arming does not fire
    const recross = evaluate(mid.state, 2.4, cfg, T0 + 120_000);
    expect(recross.alert).toBe(false);
  });

  it("re-arms once the spread drops below threshold times rearmFraction", () => {
    const first = evaluate(initialState(), 2.3, cfg, T0);
    const dropped = evaluate(first.state, 0.4, cfg, T0 + 60_000); // below 1%
    expect(dropped.state.armed).toBe(true);
  });

  it("holds the cooldown even when re-armed and re-crossing", () => {
    const first = evaluate(initialState(), 2.3, cfg, T0);
    const dropped = evaluate(first.state, 0.4, cfg, T0 + 60_000); // re-arm
    // re-cross 10 minutes later, inside the 30 minute cooldown
    const recross = evaluate(dropped.state, 2.5, cfg, T0 + 10 * 60_000);
    expect(recross.alert).toBe(false);
    expect(recross.state.armed).toBe(true); // still armed, just cooled down
  });

  it("fires again after the cooldown once re-armed and re-crossing", () => {
    const first = evaluate(initialState(), 2.3, cfg, T0);
    const dropped = evaluate(first.state, 0.4, cfg, T0 + 60_000);
    const recross = evaluate(dropped.state, 2.5, cfg, T0 + 31 * 60_000);
    expect(recross.alert).toBe(true);
    expect(recross.state.lastAlertMs).toBe(T0 + 31 * 60_000);
  });

  it("fires on a negative spread past the threshold (pool below fair)", () => {
    const { alert } = evaluate(initialState(), -2.5, cfg, T0);
    expect(alert).toBe(true);
  });

  it("never fires on a null or non-finite spread", () => {
    expect(evaluate(initialState(), null, cfg, T0).alert).toBe(false);
    expect(evaluate(initialState(), Number.NaN, cfg, T0).alert).toBe(false);
  });
});
