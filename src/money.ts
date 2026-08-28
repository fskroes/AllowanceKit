export const MICRO = 1_000_000n;

export function usd(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

export function fmtUsd(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

export function fmtUsdExact(micro: bigint): string {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0");
  return `$${whole}.${frac}`;
}

/** Two decimals for normal amounts, full precision for true micropayments. */
export function fmtUsdSmart(micro: bigint): string {
  const abs = micro < 0n ? -micro : micro;
  return abs > 0n && abs < 10_000n ? fmtUsdExact(micro) : fmtUsd(micro);
}
