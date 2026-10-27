/**
 * Token amount helpers for the transfer commands.
 *
 * The decimals of a token decide how a human amount ("1") turns into
 * base units ("100000000"). For the configured KOIN and VHP contracts
 * that number is fixed at 8, so it is never taken from the RPC: a
 * node that reports a different value would otherwise inflate every
 * transfer while the displayed amount stays the same. For other
 * tokens the RPC value is used, but only after it has been checked.
 */

export const SYSTEM_TOKEN_DECIMALS = 8;
export const MAX_TOKEN_DECIMALS = 18;

export interface TokenDecimalsOptions {
  /** true for the configured KOIN or VHP contract */
  systemToken: boolean;
}

/**
 * Decides the decimals used to encode a transfer amount.
 *
 * @param reported value returned by the token's `decimals` entry point,
 *   or undefined when it could not be read
 * @param options whether the contract is the configured KOIN/VHP contract
 * @throws Error when the RPC disagrees with the fixed system-token
 *   decimals, when the value is missing for a custom token, or when it
 *   is not an integer between 0 and MAX_TOKEN_DECIMALS
 */
export function resolveTokenDecimals(reported: unknown, options: TokenDecimalsOptions): number {
  const parsed = parseReportedDecimals(reported);

  if (options.systemToken) {
    if (parsed !== undefined && parsed !== SYSTEM_TOKEN_DECIMALS) {
      throw new Error(
        `The RPC reports ${String(reported)} decimals for the configured system token, expected ${SYSTEM_TOKEN_DECIMALS}. ` +
          'Refusing to transfer: the RPC endpoint may be lying about this token.',
      );
    }
    return SYSTEM_TOKEN_DECIMALS;
  }

  if (parsed === undefined) {
    throw new Error('Could not read the token decimals from the RPC. Refusing to transfer without them.');
  }
  return parsed;
}

function parseReportedDecimals(reported: unknown): number | undefined {
  if (reported === undefined || reported === null || reported === '') return undefined;

  let value: number;
  if (typeof reported === 'number') {
    value = reported;
  } else if (typeof reported === 'string' && /^\d+$/.test(reported.trim())) {
    value = Number(reported.trim());
  } else {
    throw new Error(`The token reports invalid decimals: ${JSON.stringify(reported)}`);
  }

  if (!Number.isInteger(value) || value < 0 || value > MAX_TOKEN_DECIMALS) {
    throw new Error(`The token reports unsupported decimals: ${String(reported)} (allowed: 0 to ${MAX_TOKEN_DECIMALS}).`);
  }
  return value;
}

/**
 * Converts a human amount ("1.5") into base units using exact integer
 * arithmetic. Rejects anything that is not a positive plain decimal
 * number or that has more fractional digits than the token supports.
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new Error(`Unsupported token decimals: ${String(decimals)}.`);
  }

  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Amount must be a positive decimal number.');
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  if (fractionalPart.length > decimals) {
    throw new Error(`Amount has too many decimal places. This token supports ${decimals} decimals.`);
  }

  const paddedFractional = fractionalPart.padEnd(decimals, '0');
  const raw = BigInt(wholePart || '0') * BigInt(10) ** BigInt(decimals) + BigInt(paddedFractional || '0');

  if (raw <= BigInt(0)) {
    throw new Error('Amount must be greater than zero.');
  }

  return raw;
}
