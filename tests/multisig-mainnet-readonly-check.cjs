// Read-only audit check of the two-RPC finality helper on real Mainnet data (no transaction, no key, no wallet).
// usage: KCLI_ROOT=<built kcli> node multisig-mainnet-readonly-check.cjs <out.json> [primary rpc] [witness rpc]
//
// Reproduces the class of defect corrected in kcli 1.7.0 (MULTISIG_FINALITY_FIX.md) against live RPCs: with one
// captured head pair and H = min(head heights) where max(LIB1, LIB2) < H, the corrected call
// corroborate(primary, witness, head1, head2) must pass, while the pre-fix call shape corroborate(..., H) must fail
// with the build's refusal "Independent irreversible finality is not established." Only chain.get_chain_id,
// chain.get_head_info and block_store.get_blocks_by_height are allowed; every request and raw response is retained; the
// exact request sequence per endpoint is asserted; redirects are refused; each request has a 20 s deadline. The witness may
// be a local SSH tunnel to a node we operate (M1_TUNNEL_WITNESS=1, http://host.docker.internal:<port>/), recorded as such.
// Exit 0 = pass (helper regression demonstrated), 1 = fail (helper misbehaved), 2 = inconclusive (public observation
// unavailable, unsuitable or inconsistent, or bad invocation). The evidence file is always written when a path is given.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [out, primaryUrl = 'https://api.koinos.io/', witnessUrl = 'https://api.koinosblocks.com/'] = process.argv.slice(2);
const record = { schema: 1, kind: 'mainnet read-only corroboration check', primary: primaryUrl, witness: witnessUrl, startedAt: new Date().toISOString() };
const traces = { primary: [], witness: [] };
const finish = (code, verdict, line) => {
  record.verdict = verdict; record.finishedAt = new Date().toISOString(); record.trace = traces;
  if (out) { try { fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); } catch (e) { console.error('cannot write evidence: ' + e.message + ' -> inconclusive'); console.log(line); process.exit(2); } }
  console.log(line); process.exit(code);
};
const ALLOWED = new Set(['chain.get_chain_id', 'chain.get_head_info', 'block_store.get_blocks_by_height']);
const EXPECTED_SEQUENCE = ['chain.get_chain_id', 'chain.get_head_info', 'block_store.get_blocks_by_height', 'block_store.get_blocks_by_height', 'block_store.get_blocks_by_height'];
class TransportError extends Error {}
(async () => {
  try {
    if (!out) return finish(2, 'inconclusive', 'INCONCLUSIVE output file required');
    const ROOT = process.env.KCLI_ROOT; if (!ROOT) { record.reason = 'KCLI_ROOT not set'; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
    const { Provider } = require(path.join(ROOT, 'node_modules', 'koilib'));
    const VN = require(path.join(ROOT, 'dist', 'vortex-network'));
    // Witness may be a reviewed local SSH tunnel to a node we operate (http://host.docker.internal:<port>/) ONLY when
    // M1_TUNNEL_WITNESS=1 is set explicitly; the primary must always be a public HTTPS endpoint.
    const tunnelMatch = /^http:\/\/host\.docker\.internal:([1-9][0-9]{0,4})\/$/.exec(witnessUrl);
    const tunnelOk = process.env.M1_TUNNEL_WITNESS === '1' && !!tunnelMatch && Number(tunnelMatch[1]) <= 65535;
    record.witnessIsLocalTunnel = tunnelOk;
    // Public endpoints must satisfy the build's own Mainnet RPC rule (canonical URL, public hostname, HTTPS): VN.rpcUrl(..., 'mainnet').
    const publicOk = u => { try { VN.rpcUrl(u, 'mainnet'); return true; } catch { return false; } }; // throws on non-public, non-HTTPS or non-canonical URLs
    if (!publicOk(primaryUrl)) { record.reason = 'primary must be a reviewed public HTTPS Mainnet RPC: ' + primaryUrl; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
    if (!tunnelOk && !publicOk(witnessUrl)) { record.reason = 'witness must be a reviewed public HTTPS Mainnet RPC (or M1_TUNNEL_WITNESS=1 with http://host.docker.internal:<1-65535>/): ' + witnessUrl; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
    if (primaryUrl === witnessUrl) { record.reason = 'two distinct endpoints required'; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }

    record.expectedRequestSequence = EXPECTED_SEQUENCE;
    // Own transport: allowlisted methods only, no redirects, bounded, raw responses retained. Provider's dispatch is bypassed entirely.
    const guarded = (url, trace) => {
      const p = new Provider(url);
      p.call = async (method, params) => {
        if (!ALLOWED.has(method)) throw Error('method not allowed in read-only check: ' + method);
        const entry = { at: new Date().toISOString(), method, params }; trace.push(entry);
        let text, json;
        try {
          const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          entry.httpStatus = res.status; text = await res.text(); entry.rawResponse = text.length > 200000 ? text.slice(0, 200000) + '…[truncated]' : text;
        } catch (e) { entry.transportError = String(e.message || e); throw new TransportError(entry.transportError); }
        try { json = JSON.parse(text); } catch { entry.transportError = 'non-JSON response'; throw new TransportError('non-JSON response (HTTP ' + entry.httpStatus + ')'); }
        if (json.result !== undefined) return json.result;
        throw new TransportError('rpc error: ' + JSON.stringify(json.error));
      };
      return p;
    };
    const P = guarded(primaryUrl, traces.primary), W = guarded(witnessUrl, traces.witness);
    const big = v => BigInt(v);
    const chainP = await P.getChainId(), chainW = await W.getChainId();
    if (chainP !== VN.MAINNET_CHAIN || chainW !== VN.MAINNET_CHAIN) { record.reason = 'an endpoint is not Mainnet'; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
    // One captured head pair, used for both calls.
    const a = await P.getHeadInfo(), b = await W.getHeadInfo();
    record.heads = { primary: a, witness: b };
    const lo = big(a.last_irreversible_block) > big(b.last_irreversible_block) ? big(a.last_irreversible_block) : big(b.last_irreversible_block);
    const hi = big(a.head_topology.height) < big(b.head_topology.height) ? big(a.head_topology.height) : big(b.head_topology.height);
    if (!(lo < hi)) { record.reason = 'no common height above both LIBs in this head pair'; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
    const H = hi; record.height = String(H); record.cases = {};
    // Corrected call shape (kcli >= 1.7.0): no minimum height. A refusal here means the public observation is unsuitable
    // (stale, skewed or inconsistent heads), not a helper regression -> inconclusive.
    try { await VN.corroborate(P, W, a, b); record.cases.corrected = { call: 'corroborate(primary, witness, a, b)', outcome: 'passed' }; }
    catch (e) {
      record.cases.corrected = { call: 'corroborate(primary, witness, a, b)', outcome: 'threw', errorType: e?.constructor?.name, message: String(e.message || e) };
      record.reason = (e instanceof TransportError ? 'transport failure' : 'public heads unsuitable for corroboration') + ': ' + String(e.message || e);
      return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason);
    }
    // Pre-fix call shape (PR #2 head 00813ff): minimum = transaction height; must fail at the LIB check with the build's refusal type.
    try { await VN.corroborate(P, W, a, b, H); record.cases.prefixShape = { call: 'corroborate(primary, witness, a, b, H)', outcome: 'passed (unexpected)' }; }
    catch (e) {
      if (e instanceof TransportError) { record.reason = 'transport failure during the pre-fix-shape call: ' + e.message; return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
      record.cases.prefixShape = { call: 'corroborate(primary, witness, a, b, H)', outcome: 'threw', errorType: e?.constructor?.name, message: String(e.message || e) };
    }
    const seq = t => t.map(x => x.method);
    const seqOk = JSON.stringify(seq(traces.primary)) === JSON.stringify(EXPECTED_SEQUENCE) && JSON.stringify(seq(traces.witness)) === JSON.stringify(EXPECTED_SEQUENCE);
    const pre = record.cases.prefixShape;
    const ok = pre.outcome === 'threw' && pre.errorType === 'RefusalError' && pre.message === 'Independent irreversible finality is not established.' && seqOk;
    record.sequenceMatched = seqOk;
    return finish(ok ? 0 : 1, ok ? 'pass' : 'fail', (ok ? 'PASS' : 'FAIL') + ' mainnet corroboration check at height ' + H + ' (LIBs ' + a.last_irreversible_block + '/' + b.last_irreversible_block + '); requests ' + traces.primary.length + '+' + traces.witness.length);
  } catch (e) { record.reason = (e instanceof TransportError ? 'transport: ' : 'error: ') + String(e.message || e).slice(0, 300); return finish(2, 'inconclusive', 'INCONCLUSIVE ' + record.reason); }
})();
