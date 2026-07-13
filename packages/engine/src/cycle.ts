// cycle arithmetic. a cycle is a fixed-length wall-clock bucket:
// cycle_id = floor(unix_seconds / cycle_seconds). deterministic everywhere,
// no coordination needed between services.

export function cycleIdFor(unixMs: number, cycleSeconds: number): number {
  if (cycleSeconds <= 0) throw new Error("cycleSeconds must be positive");
  return Math.floor(unixMs / 1000 / cycleSeconds);
}

export function cycleStartMs(cycleId: number, cycleSeconds: number): number {
  return cycleId * cycleSeconds * 1000;
}

export function cycleEndMs(cycleId: number, cycleSeconds: number): number {
  return (cycleId + 1) * cycleSeconds * 1000;
}
