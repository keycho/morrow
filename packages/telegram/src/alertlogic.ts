// divergence alert state machine. pure. decides when a token's spread
// crossing should fire an alert, with hysteresis and a per-token cooldown so
// oscillation around the threshold does not spam the channel.
//
// hysteresis: after firing, the token disarms and only re-arms once the
// spread falls back below threshold * rearmFraction. cooldown: even a
// re-armed re-crossing waits out the minimum time between alerts.

export interface AlertConfig {
  thresholdPct: number;
  rearmFraction: number;
  cooldownMs: number;
}

export interface AlertState {
  armed: boolean;
  lastAlertMs: number;
}

export function initialState(): AlertState {
  // armed so the first genuine crossing fires; never alerted yet.
  return { armed: true, lastAlertMs: Number.NEGATIVE_INFINITY };
}

export function evaluate(
  prev: AlertState,
  spreadPct: number | null,
  cfg: AlertConfig,
  nowMs: number
): { alert: boolean; state: AlertState } {
  if (spreadPct === null || !Number.isFinite(spreadPct)) {
    return { alert: false, state: prev };
  }
  const abs = Math.abs(spreadPct);
  let armed = prev.armed;

  // re-arm once the spread has clearly retreated from the threshold.
  if (abs < cfg.thresholdPct * cfg.rearmFraction) {
    armed = true;
  }

  const cooldownOk = nowMs - prev.lastAlertMs >= cfg.cooldownMs;
  if (armed && abs >= cfg.thresholdPct && cooldownOk) {
    return { alert: true, state: { armed: false, lastAlertMs: nowMs } };
  }
  return { alert: false, state: { armed, lastAlertMs: prev.lastAlertMs } };
}
