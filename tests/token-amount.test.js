const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTokenDecimals, parseTokenAmount, SYSTEM_TOKEN_DECIMALS, MAX_TOKEN_DECIMALS } = require('../dist/token-amount.js');

const system = { systemToken: true };
const custom = { systemToken: false };

test('system tokens always use 8 decimals and refuse a disagreeing RPC', () => {
  assert.equal(SYSTEM_TOKEN_DECIMALS, 8);
  assert.equal(resolveTokenDecimals(undefined, system), 8);
  assert.equal(resolveTokenDecimals(8, system), 8);
  assert.equal(resolveTokenDecimals('8', system), 8);
  for (const reported of [10, '10', 0, 18, 7]) {
    assert.throws(() => resolveTokenDecimals(reported, system), /expected 8/);
  }
  assert.throws(() => resolveTokenDecimals('abc', system), /invalid decimals/);
});

test('a transfer of 1 KOIN encodes exactly 100,000,000 base units whatever the RPC says', () => {
  // The acceptance check from the report: RPC claims 10 decimals for the
  // configured KOIN contract. The transfer must be refused or encode 1e8.
  assert.throws(() => resolveTokenDecimals(10, system));
  const decimals = resolveTokenDecimals(undefined, system);
  assert.equal(parseTokenAmount('1', decimals), 100000000n);
});

test('custom tokens use the reported decimals only when they are sane', () => {
  assert.equal(resolveTokenDecimals(0, custom), 0);
  assert.equal(resolveTokenDecimals(6, custom), 6);
  assert.equal(resolveTokenDecimals('18', custom), 18);
  assert.equal(resolveTokenDecimals(MAX_TOKEN_DECIMALS, custom), MAX_TOKEN_DECIMALS);
  assert.throws(() => resolveTokenDecimals(undefined, custom), /Could not read/);
  assert.throws(() => resolveTokenDecimals(null, custom), /Could not read/);
  assert.throws(() => resolveTokenDecimals('', custom), /Could not read/);
  for (const reported of [19, 255, -1, 1.5, '1e3', ' 9 9', 'eight', true, {}, [8]]) {
    assert.throws(() => resolveTokenDecimals(reported, custom), /decimals/);
  }
});

test('parseTokenAmount is exact and rejects excess precision', () => {
  assert.equal(parseTokenAmount('1', 8), 100000000n);
  assert.equal(parseTokenAmount('0.00000001', 8), 1n);
  assert.equal(parseTokenAmount('1.99999999', 8), 199999999n);
  assert.equal(parseTokenAmount('123', 0), 123n);
  assert.equal(parseTokenAmount('1', 18), 10n ** 18n);
  assert.throws(() => parseTokenAmount('1.999999995', 8), /too many decimal places/);
  assert.throws(() => parseTokenAmount('1.5', 0), /too many decimal places/);
  assert.throws(() => parseTokenAmount('0', 8), /greater than zero/);
  assert.throws(() => parseTokenAmount('0.0', 8), /greater than zero/);
  for (const bad of ['', '-1', '+1', '1e8', '1.', '.5', '1,5', 'abc', '1 0']) {
    assert.throws(() => parseTokenAmount(bad, 8), /positive decimal number/);
  }
  for (const decimals of [-1, 19, 1.5, NaN]) {
    assert.throws(() => parseTokenAmount('1', decimals), /Unsupported token decimals/);
  }
});
