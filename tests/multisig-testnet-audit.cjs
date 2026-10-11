// Independent adversarial audit driver for a LIVE treasury on the official testnet (test-only keys and tKOIN).
// Independent oracle: koilib + raw JSON-RPC only; never kcli and never kcli's production validators. The treasury
// ABI comes from the built artifact, the KOIN ABI from koilib's bundled token ABI.
// usage: KCLI_ROOT=<kcli checkout (for node_modules only)> node multisig-testnet-audit.cjs <action> <work dir> [args]
// actions: attack-keys | matrix <funder key json> | replay <approved package json> | allowance <funder key json>
//          | proofs <evidence-cli.json> | summary
// Every case records: mutation, signer addresses, payer/payee, the exact submitted transaction (hashed), the
// admission result with the Koinos error code from the JSON-RPC error data, state before/after (nonce, Mana,
// balance), expected vs observed, verdict pass | fail | inconclusive. Rejections must leave nonce and balance
// unchanged; Mana may only regenerate upward.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const https = require('node:https');
const ROOT = process.env.KCLI_ROOT; assert(ROOT, 'set KCLI_ROOT');
const { Contract, Provider, Signer, Transaction, utils } = require(path.join(ROOT, 'node_modules', 'koilib'));
const secp = require(require.resolve('@noble/secp256k1', { paths: [path.join(ROOT, 'node_modules', 'koilib')] }));
const RPC = 'https://testnet.koinosfoundation.org/jsonrpc';
const CHAIN = 'EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==';
const MAINNET_CHAIN = 'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==';
const KOIN = '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju';
const EMPTY_WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const [action, W, ...args] = process.argv.slice(2);
assert(action && W, 'usage: <action> <work dir> [args]');
const RUN_ID = process.env.RUN_ID || null;
const p = new Provider(RPC);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
const redact = s => String(s).replace(/\b[5KL][1-9A-HJ-NP-Za-km-z]{49,51}\b/g, '[redacted-key]');
const random = () => new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
const k = s => ({ address: s.getAddress(), wif: s.getPrivateKey('wif') });
// Hand-written KOIN schema (public KCS-4 KOIN contract: transfer 0x27f576ca, approve 0x74e21680, burn 0x859facc5,
// balance_of 0x5c721497, allowance 0x32f09fa1); independent of kcli and of koilib's bundled token ABI.
const F = (type, id, btype, rule) => ({ type, id, ...(rule ? { rule } : {}), ...(btype ? { options: { '(koinos.btype)': btype } } : {}) });
const KOIN_ABI = { methods: {
    transfer: { argument: 'koin.transfer_arguments', return: 'koin.empty', entry_point: 0x27f576ca, read_only: false },
    approve: { argument: 'koin.approve_arguments', return: 'koin.empty', entry_point: 0x74e21680, read_only: false },
    burn: { argument: 'koin.burn_arguments', return: 'koin.empty', entry_point: 0x859facc5, read_only: false },
    balance_of: { argument: 'koin.balance_of_arguments', return: 'koin.uint64', entry_point: 0x5c721497, read_only: true },
    allowance: { argument: 'koin.allowance_arguments', return: 'koin.uint64', entry_point: 0x32f09fa1, read_only: true } },
  koilib_types: { nested: { koin: { nested: {
    transfer_arguments: { fields: { from: F('bytes', 1, 'ADDRESS'), to: F('bytes', 2, 'ADDRESS'), value: F('uint64', 3), memo: F('string', 4) } },
    approve_arguments: { fields: { owner: F('bytes', 1, 'ADDRESS'), spender: F('bytes', 2, 'ADDRESS'), value: F('uint64', 3) } },
    burn_arguments: { fields: { from: F('bytes', 1, 'ADDRESS'), value: F('uint64', 2) } },
    balance_of_arguments: { fields: { owner: F('bytes', 1, 'ADDRESS') } },
    allowance_arguments: { fields: { owner: F('bytes', 1, 'ADDRESS'), spender: F('bytes', 2, 'ADDRESS') } },
    transfer_event: { fields: { from: F('bytes', 1, 'ADDRESS'), to: F('bytes', 2, 'ADDRESS'), value: F('uint64', 3), memo: F('string', 4) } },
    uint64: { fields: { value: F('uint64', 1) } }, empty: { fields: {} } } } } } };
const koin = new Contract({ id: KOIN, abi: KOIN_ABI, provider: p });
const AUDIT = path.join(W, 'audit'); fs.mkdirSync(AUDIT, { recursive: true, mode: 0o700 });
const keysFile = path.join(W, 'keys.json');

// ---- raw JSON-RPC (keeps the Koinos error code that koilib's Provider drops) ----
function rpc(method, params, deadlineMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }); let settled = false;
    const req = https.request(RPC, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { clearTimeout(timer); settled = true; try { resolve(JSON.parse(d)); } catch { reject(Error('non-JSON RPC reply')); } });
    });
    const timer = setTimeout(() => { if (!settled) { settled = true; req.destroy(); reject(Error('rpc deadline (' + deadlineMs + ' ms) exceeded: ' + method)); } }, deadlineMs);
    req.on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } }); req.end(body);
  });
}
async function submit(tx) { // admission dimension only; canonical execution is proven separately (proofs)
  let r; try { r = await rpc('chain.submit_transaction', { transaction: tx, broadcast: true }); } catch (e) { return { admission: 'inconclusive', transport: String(e.message || e) }; }
  if (r.result) return { admission: 'accepted', receipt: r.result.receipt };
  const err = r.error || {}; let data = {};
  if (err.data && typeof err.data === 'object') data = err.data; else { try { data = JSON.parse(err.data); } catch { data = { raw: err.data }; } }
  if (Array.isArray(data.logs)) data.logs = data.logs.slice(0, 20).map(x => redact(x).slice(0, 200));
  return { admission: 'rejected', rpcCode: err.code, message: redact(err.message || ''), code: typeof data.code === 'number' ? data.code : null, data: JSON.parse(redact(JSON.stringify(data))) };
}
// ---- transactions ----
const varint = n => { const out = []; let v = BigInt(n); do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v); return Buffer.from(out); };
const encodeNonce = n => utils.encodeBase64url(Buffer.concat([Buffer.from([0x28]), varint(n)])); // koinos value_type int64_value (field 5)
async function build(payer, operations, { rcLimit = '20000000', nonce, chainId = CHAIN, payee } = {}) {
  const account = payee || payer; // the payee, when set, is the nonce account
  if (nonce === undefined) { // own encoding (value_type.uint64_value, tag 0x28) cross-checked against koilib's encoder on every build
    const own = encodeNonce(BigInt(await p.getNonce(account)) + 1n), lib = await p.getNextNonce(account);
    assert.equal(own.replace(/=+$/, ''), lib.replace(/=+$/, ''), 'nonce encoding disagrees with koilib'); nonce = lib;
  }
  const header = { chain_id: chainId, payer, rc_limit: rcLimit, nonce };
  if (payee) header.payee = payee;
  return Transaction.prepareTransaction({ header, operations, signatures: [] });
}
const idBytes = t => Buffer.from(t.id.slice(6), 'hex');
async function sign(t, ...signers) { for (const s of signers) t.signatures.push(utils.encodeBase64url(await s.signHash(idBytes(t)))); return t; }
async function signFresh(t, s) { // a second, different valid signature by the same key (extra entropy)
  const [sig, rec] = await secp.sign(idBytes(t), s.getPrivateKey('hex'), { recovered: true, canonical: true, der: false, extraEntropy: true });
  t.signatures.push(utils.encodeBase64url(Buffer.concat([Buffer.from([rec + 31]), Buffer.from(sig)]))); return t;
}
function malleate(sigB64) { // the same signature in non-canonical (high-s) form
  const b = Buffer.from(utils.decodeBase64url(sigB64)); const n = secp.CURVE.n;
  const s = BigInt('0x' + b.subarray(33).toString('hex'));
  return utils.encodeBase64url(Buffer.concat([Buffer.from([((b[0] - 31) ^ 1) + 31]), b.subarray(1, 33), Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')]));
}
const transferOp = async (from, to, value) => koin.encodeOperation({ name: 'transfer', args: { from, to, value: String(value) } });
const transferMemoOp = async (from, to, value, memo) => koin.encodeOperation({ name: 'transfer', args: { from, to, value: String(value), memo } }); // field 4 present
function uploadOp(contractId, dir, flags = { call: true, transaction: true, upload: true }, tiny = false) {
  return { upload_contract: { contract_id: contractId, bytecode: utils.encodeBase64url(tiny ? EMPTY_WASM : fs.readFileSync(path.join(dir, 'contract.wasm'))), ...(tiny ? {} : { abi: fs.readFileSync(path.join(dir, 'treasury.abi'), 'utf8') }),
    authorizes_call_contract: flags.call, authorizes_transaction_application: flags.transaction, authorizes_upload_contract: flags.upload } };
}
function treasuryContract(address, artifactDir) {
  const abi = read(path.join(artifactDir, 'treasury.abi')); const methods = {};
  for (const [n, m] of Object.entries(abi.methods)) methods[n] = { ...m, entry_point: m.entry_point ?? m['entry-point'], read_only: m.read_only ?? m['read-only'] };
  return new Contract({ id: address, abi: { methods, koilib_types: abi.koilib_types }, provider: p });
}
// ---- state and verdicts ----
const balance = async a => BigInt((await koin.functions.balance_of({ owner: a })).result?.value || '0');
async function state(a) { const h = await p.getHeadInfo(); return { nonce: String(await p.getNonce(a)), rc: String(await p.getAccountRc(a)), balance: String(await balance(a)), head: h.head_topology.height, headTime: h.head_block_time }; }
async function states(list) { const out = {}; for (const a of [...new Set(list)]) out[a] = await state(a); return out; }
// A rejected admission commits nothing: nonce and balance identical, Mana only ever higher (regeneration).
function unchanged(before, after) { return Object.keys(before).every(a => before[a].nonce === after[a].nonce && before[a].balance === after[a].balance && BigInt(after[a].rc) >= BigInt(before[a].rc)); }
const cases = []; let counter = 0;
async function runCase(id, objective, { expectedCodes, expectedMessage, mutation, signers, payer, payee, account }, makeTx) {
  const n = String(++counter).padStart(2, '0'); const treasury = account || payer; const watched = [payer, payee, treasury].filter(Boolean);
  const rec = { caseId: id, runId: RUN_ID, objective, mutation, signers, payer, payee: payee || null, nonceAccount: payee || payer, treasury, expected: { admission: 'rejected', codes: expectedCodes, messagePattern: expectedMessage ? expectedMessage.source : null } };
  try {
    const before = await states(watched); const t = await makeTx();
    rec.transactionId = t.id; rec.nonce = t.header.nonce; rec.signedTransactionSha256 = sha(JSON.stringify(t)); rec.operations = t.operations.length; rec.signatureCount = t.signatures.length;
    fs.writeFileSync(path.join(AUDIT, `tx-${n}-${id}.json`), JSON.stringify(t, null, 1), { mode: 0o600 });
    const r = await submit(t); rec.observed = r;
    const after = await states(watched); rec.state = { before, after, unchanged: unchanged(before, after) };
    if (r.admission === 'inconclusive') rec.verdict = 'inconclusive';
    else rec.verdict = r.admission === 'rejected' && expectedCodes.includes(r.code) && (!expectedMessage || expectedMessage.test(r.message + ' ' + JSON.stringify(r.data))) && rec.state.unchanged ? 'pass' : 'fail';
  } catch (e) { rec.verdict = 'inconclusive'; rec.error = redact(e.message || e).slice(0, 300); }
  cases.push(rec); write(path.join(AUDIT, `case-${n}-${id}.json`), rec);
  console.log(`${rec.verdict.toUpperCase().padEnd(12)} ${id}: ${objective}` + (rec.observed ? ` -> ${rec.observed.admission} code=${rec.observed.code} ${(rec.observed.message || '').slice(0, 70)}` : ` (${rec.error})`));
  if (rec.verdict !== 'pass') { console.error('NON-PASS VERDICT (' + rec.verdict + ', ' + (rec.observed?.admission || rec.error) + '): stopping immediately, nothing further is submitted'); process.exit(1); }
  return rec;
}
// The canonical inclusion of a transaction: among all containing blocks (others may be orphans), the one on the head's chain.
const headInfo = async () => { const r = await rpc('chain.get_head_info', {}); if (!r.result) throw Error('head info unavailable: ' + JSON.stringify(r.error).slice(0, 200)); return r.result; }; // bounded, unlike Provider.getHeadInfo
// Canonical JSON (sorted keys) so structural equality does not depend on property order.
const canon = x => Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}' : JSON.stringify(x);
// The ONE verifier of a transaction's execution: among all containing blocks (others may be orphans) the one on the head's chain,
// with the canonical lookup's id AND height matching the item, block/receipt anchors consistent, the included body equal to the
// submitted one (header, operations; signature multiset) when given, the receipt present and not reverted, and irreversibility.
async function canonicalInclusion(id, head, deadline = Infinity, submitted = null) {
  const check = () => { if (Date.now() > deadline) throw Error('INCONCLUSIVE: deadline reached while locating the canonical inclusion of ' + id); };
  check(); const inc = await rpc('transaction_store.get_transactions_by_id', { transaction_ids: [id] }); const blocks = inc.result?.transactions?.[0]?.containing_blocks || [];
  const out = { transactionId: id, containingBlocks: blocks, blockId: null, ok: false };
  for (const bid of blocks) {
    check(); const b = await rpc('block_store.get_blocks_by_id', { block_ids: [bid], return_block: true, return_receipt: true }); const item = b.result?.block_items?.[0]; if (!item) continue;
    check(); const canonical = await rpc('block_store.get_blocks_by_height', { head_block_id: head.head_topology.id, ancestor_start_height: item.block_height, num_blocks: 1, return_block: false, return_receipt: false });
    const look = canonical.result?.block_items?.[0];
    if (!look || look.block_id !== bid) continue;
    const txr = item.receipt?.transaction_receipts?.find(x => x.id === id) || null; const body = item.block?.transactions?.find(x => x.id === id) || null;
    Object.assign(out, {
      blockId: bid, height: item.block_height, item, canonicalLookup: { blockId: look.block_id, height: look.block_height, headId: head.head_topology.id, headHeight: head.head_topology.height, lib: head.last_irreversible_block },
      heightsConsistent: String(look.block_height) === String(item.block_height) && String(item.block?.header?.height) === String(item.block_height) && String(item.receipt?.height) === String(item.block_height),
      anchorsConsistent: item.block_id === bid && item.block?.id === bid && item.receipt?.id === bid,
      irreversible: BigInt(head.last_irreversible_block) >= BigInt(item.block_height),
      body, receipt: txr, reverted: txr ? txr.reverted === true : null,
      bodyMatchesSubmitted: submitted ? !!body && canon(body.header) === canon(submitted.header) && canon(body.operations) === canon(submitted.operations) && canon([...(body.signatures || [])].sort()) === canon([...(submitted.signatures || [])].sort()) : null });
    out.ok = !!(out.heightsConsistent && out.anchorsConsistent && out.irreversible && txr && out.reverted === false && body && (submitted === null || out.bodyMatchesSubmitted));
    return out;
  }
  return out;
}
// Canonical inclusion, optionally irreversible, verified against the submitted body when given; wall-clock bound 10 minutes. Returns the verifier result.
async function waitIncluded(id, irreversible = false, submitted = null) {
  const deadline = Date.now() + 600000; // each request inside is bounded by rpc()'s absolute 30 s deadline (max overshoot: one request)
  while (Date.now() < deadline) {
    const head = await headInfo(); const c = await canonicalInclusion(id, head, deadline, submitted);
    if (c.blockId && c.heightsConsistent && c.anchorsConsistent && c.reverted === false && c.body && (submitted === null || c.bodyMatchesSubmitted) && (!irreversible || c.irreversible)) {
      if (Date.now() > deadline) throw Error('INCONCLUSIVE: canonical inclusion of ' + id + ' observed only after the 10-minute deadline'); return c; // success only inside the budget
    }
    if (c.blockId && (c.reverted === true || c.bodyMatchesSubmitted === false)) throw Error('canonical inclusion of ' + id + ' is reverted or differs from the submitted body');
    await new Promise(res => setTimeout(res, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
  throw Error('INCONCLUSIVE: transaction not canonically ' + (irreversible ? 'irreversible' : 'included') + ' within 10 minutes: ' + id);
}
// Decode a KOIN transfer event from a receipt (event.data is base64url protobuf); null when it is not a KOIN transfer event.
async function transferEvent(ev) {
  if (!ev || ev.source !== KOIN || !/transfer_event$/.test(ev.name || '')) return null;
  const d = await koin.serializer.deserialize(ev.data, 'koin.transfer_event'); return { from: d.from, to: d.to, value: String(d.value ?? '0'), memo: d.memo || '' };
}
const rawAmount = dec => { const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(dec)); assert(m, 'decimal amount'); return BigInt(m[1]) * 100000000n + BigInt((m[2] || '').padEnd(8, '0')); };
function funder(file) { const j = read(file); const s = Signer.fromWif(j.wif); assert.equal(s.getAddress(), j.address, 'funder key/address'); return s; }
const AUTH = /authoriz/, NONCE = /nonce/, CHAINID = /chain id/i, CANON = /canonical|signature/i, BUFFER = /buffer/i;

(async () => {
  assert.equal(await p.getChainId(), CHAIN, 'not the official testnet chain');
  switch (action) {
    case 'attack-keys': { // fresh address for the allowance-before-upload case
      assert(!fs.existsSync(path.join(W, 'attack.json')), 'refuse repeated key generation');
      const keys = read(keysFile); const a = k(random());
      write(path.join(W, 'attack.json'), { attack: a });
      const inputs = read(path.join(W, 'inputs.json')); write(path.join(W, 'inputs-attack.json'), { ...inputs, treasury: a.address });
      console.log('ATTACK address ' + a.address + ' (same owners as the treasury: ' + keys.owners.length + ')'); break;
    }
    case 'fund': { // funder -> account, exact amount in tKOIN (integer), id retained for the proofs
      const F = funder(args[0]); const to = args[1]; assert(/^[1-9][0-9]?$/.test(args[2]), 'whole tKOIN amount 1-99'); const raw = BigInt(args[2]) * 100000000n;
      const f = path.join(AUDIT, 'funding.json'); const ledger = fs.existsSync(f) ? read(f) : { funder: F.getAddress(), funderInitialBalance: String(await balance(F.getAddress())), funderInitialMana: String(await p.getAccountRc(F.getAddress())), entries: [] };
      const t = await sign(await build(F.getAddress(), [await transferOp(F.getAddress(), to, raw)], { rcLimit: '50000000' }), F);
      const entry = { role: 'funding', transactionId: t.id, to, tkoin: Number(args[2]), raw: String(raw), payer: F.getAddress(), signedTransactionSha256: sha(JSON.stringify(t)), admission: null };
      fs.writeFileSync(path.join(AUDIT, `tx-fund-${ledger.entries.length + 1}.json`), JSON.stringify(t, null, 1), { mode: 0o600 }); ledger.entries.push(entry); write(f, ledger); // persisted BEFORE the send
      const r = await submit(t); entry.admission = r.admission; entry.rpc = r.admission === 'accepted' ? { rc_used: r.receipt?.rc_used } : r; write(f, ledger);
      assert.equal(r.admission, 'accepted', 'funding: ' + JSON.stringify(r).slice(0, 200));
      const inc = await waitIncluded(t.id, false, t); entry.block = inc.blockId; entry.height = inc.height; entry.rc_used = inc.receipt?.rc_used; write(f, ledger);
      console.log('FUNDED ' + args[2] + ' tKOIN -> ' + to + ' (' + t.id + ')'); break;
    }
    case 'matrix': {
      const F = funder(args[0]); const o = F.getAddress(); // the outsider with Mana is the test funder itself
      const keys = read(keysFile); const t = keys.treasury.address; const T = Signer.fromWif(keys.treasury.wif);
      const owners = keys.owners.map(x => Signer.fromWif(x.wif)); const addr = owners.map(x => x.getAddress());
      const q = owners.slice(0, 3); const qa = addr.slice(0, 3); const to = keys.recipient.address; const art = path.join(W, 'artifact');
      const c = treasuryContract(t, art); const nonOwner = Signer.fromWif(keys.future.wif);
      const policyOp = (ownersList, threshold) => c.encodeOperation({ name: 'set_policy', args: { owners: ownersList, threshold } });
      const quorumTx = async (ops, opts) => sign(await build(t, ops, opts), ...q);
      // A1 — the address key alone
      await runCase('A1-key-transfer', 'address key alone: KOIN transfer', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'signed by the treasury address key only', signers: [t], payer: t }, async () => sign(await build(t, [await transferOp(t, to, 1)]), T));
      await runCase('A1-key-set-policy', 'address key alone: set_policy', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'treasury key only', signers: [t], payer: t }, async () => sign(await build(t, [await policyOp(addr, 4)]), T));
      await runCase('A1-key-tiny-upload', 'address key alone: 8-byte wasm replacement, flags off', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'treasury key only', signers: [t], payer: t }, async () => sign(await build(t, [uploadOp(t, art, { call: false, transaction: false, upload: false }, true)]), T));
      await runCase('A1-key-upload-outsider-paid', 'address key as sponsor, outsider pays the full-size upload', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'payer = outsider, upload signed by the treasury key', signers: [o, t], payer: o, account: t }, async () => sign(await build(o, [uploadOp(t, art, { call: false, transaction: false, upload: false })], { rcLimit: '1000000000' }), F, T));
      // A2 — below threshold
      await runCase('A2-two-of-five', 'two valid owner signatures', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '2 of 5', signers: qa.slice(0, 2), payer: t }, async () => sign(await build(t, [await transferOp(t, to, 1)]), ...q.slice(0, 2)));
      // A3 — identity counting
      await runCase('A3-same-signature-twice', 'one owner signature duplicated byte for byte + one other owner', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '3 signatures, 2 identities', signers: [qa[0], qa[0], qa[1]], payer: t }, async () => { const x = await sign(await build(t, [await transferOp(t, to, 1)]), q[0], q[1]); x.signatures.push(x.signatures[0]); return x; });
      await runCase('A3-two-distinct-sigs-one-owner', 'two different valid signatures by one owner + one other owner', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '3 signatures, 2 identities', signers: [qa[0], qa[0], qa[1]], payer: t }, async () => { const x = await sign(await build(t, [await transferOp(t, to, 1)]), q[0], q[1]); await signFresh(x, q[0]); assert.notEqual(x.signatures[0], x.signatures[2]); return x; });
      // A4 — any invalid signature refuses
      await runCase('A4-quorum-plus-non-owner', 'full quorum plus one non-owner signature', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '4 signatures, one by a non-owner', signers: [...qa, nonOwner.getAddress()], payer: t }, async () => sign(await quorumTx([await transferOp(t, to, 1)]), nonOwner));
      await runCase('A4-high-s', 'quorum where one signature is the high-s form of a valid one', { expectedCodes: [-202], expectedMessage: CANON, mutation: 'signature 0 malleated to high-s', signers: qa, payer: t }, async () => { const x = await quorumTx([await transferOp(t, to, 1)]); x.signatures[0] = malleate(x.signatures[0]); return x; });
      await runCase('A4-wrong-length', 'quorum where one signature is 64 bytes', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'signature 0 truncated to 64 bytes', signers: qa, payer: t }, async () => { const x = await quorumTx([await transferOp(t, to, 1)]); x.signatures[0] = utils.encodeBase64url(Buffer.from(utils.decodeBase64url(x.signatures[0])).subarray(0, 64)); return x; });
      // A5b — nonce gap (A5a replay runs after the real payment: action 'replay')
      await runCase('A5-nonce-gap', 'quorum transaction at nonce + 2', { expectedCodes: [-201], expectedMessage: NONCE, mutation: 'nonce = current + 2, re-signed', signers: qa, payer: t }, async () => quorumTx([await transferOp(t, to, 1)], { nonce: encodeNonce(BigInt(await p.getNonce(t)) + 2n) }));
      // A6 — envelope
      await runCase('A6-memo', 'KOIN transfer with a memo', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'memo "invoice 7"', signers: qa, payer: t }, async () => quorumTx([await transferMemoOp(t, to, 1, 'invoice 7')]));
      await runCase('A6-two-transfers', 'two transfers in one transaction', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '2 operations', signers: qa, payer: t }, async () => quorumTx([await transferOp(t, to, 1), await transferOp(t, to, 1)]));
      await runCase('A6-payee-self', 'treasury payer with payee = treasury (quorum signatures only)', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'header.payee = treasury', signers: qa, payer: t, payee: t }, async () => quorumTx([await transferOp(t, to, 1)], { payee: t }));
      await runCase('A6-payee-owner', 'treasury payer with payee = a signing owner (nonce from that owner; quorum signatures only)', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'header.payee = owner 0', signers: qa, payer: t, payee: qa[0] }, async () => quorumTx([await transferOp(t, to, 1)], { payee: qa[0] }));
      await runCase('A6-treasury-pays-other-transfer', 'treasury pays Mana for a transfer from a signing owner (no extra signature)', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'operation: owner 0 -> recipient', signers: qa, payer: t }, async () => quorumTx([await transferOp(qa[0], to, 1)]));
      await runCase('A6-outsider-payer', 'outsider pays, empty payee, quorum-signed treasury transfer (contract_call path)', { expectedCodes: [1], expectedMessage: AUTH, mutation: 'payer = outsider', signers: [o, ...qa], payer: o, account: t }, async () => sign(await build(o, [await transferOp(t, to, 1)]), F, ...q));
      // A7 — other KOIN operations by the quorum
      await runCase('A7-approve', 'quorum approves an allowance', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'approve(spender = outsider, 100)', signers: qa, payer: t }, async () => quorumTx([await koin.encodeOperation({ name: 'approve', args: { owner: t, spender: o, value: '100' } })]));
      await runCase('A7-burn', 'quorum burns', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'burn(100)', signers: qa, payer: t }, async () => quorumTx([await koin.encodeOperation({ name: 'burn', args: { from: t, value: '100' } })]));
      // A8 — upload by the quorum
      await runCase('A8-tiny-upload', 'quorum uploads an 8-byte replacement', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'tiny upload, treasury-paid', signers: qa, payer: t }, async () => quorumTx([uploadOp(t, art, { call: false, transaction: false, upload: false }, true)]));
      await runCase('A8-full-upload-treasury-paid', 'quorum re-uploads the full artifact, treasury-paid', { expectedCodes: [-1], expectedMessage: BUFFER, mutation: 'full artifact exceeds the 8 KB system buffer', signers: qa, payer: t }, async () => quorumTx([uploadOp(t, art)], { rcLimit: '1000000000' }));
      await runCase('A8-full-upload-outsider-paid', 'quorum re-uploads the full artifact, outsider-paid', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'payer = outsider', signers: [o, ...qa], payer: o, account: t }, async () => sign(await build(o, [uploadOp(t, art)], { rcLimit: '1000000000' }), F, ...q));
      // A9 — policy abuse by the quorum
      const sorted = list => [...list].sort((a, b) => Buffer.compare(Buffer.from(utils.decodeBase58(a)), Buffer.from(utils.decodeBase58(b))));
      const fresh = n => sorted(Array.from({ length: n }, () => random().getAddress()));
      await runCase('A9-threshold-1', 'set_policy threshold 1', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'threshold 1', signers: qa, payer: t }, async () => quorumTx([await policyOp(addr, 1)]));
      await runCase('A9-threshold-n', 'set_policy threshold = owner count', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'threshold 5 of 5', signers: qa, payer: t }, async () => quorumTx([await policyOp(addr, 5)]));
      await runCase('A9-duplicate-owner', 'set_policy with a duplicated owner', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'owner 1 twice', signers: qa, payer: t }, async () => quorumTx([await policyOp([addr[0], addr[1], addr[1], addr[2], addr[3]], 3)]));
      await runCase('A9-unsorted', 'set_policy with owners out of byte order', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'owners reversed', signers: qa, payer: t }, async () => quorumTx([await policyOp([...addr].reverse(), 3)]));
      await runCase('A9-sixteen-owners', 'set_policy with 16 owners', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '16 owners, threshold 9', signers: qa, payer: t }, async () => quorumTx([await policyOp(fresh(16), 9)]));
      await runCase('A9-treasury-as-owner', 'set_policy listing the treasury itself', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'treasury among owners', signers: qa, payer: t }, async () => quorumTx([await policyOp(sorted([...addr.slice(1), t]), 3)]));
      await runCase('A9-two-owners', 'set_policy with 2 owners', { expectedCodes: [-200], expectedMessage: AUTH, mutation: '2 owners, threshold 2', signers: qa, payer: t }, async () => quorumTx([await policyOp(addr.slice(0, 2), 2)]));
      await runCase('A9-wrong-entry-point', 'set_policy arguments sent to the get_policy entry point', { expectedCodes: [-200], expectedMessage: AUTH, mutation: 'entry point of get_policy', signers: qa, payer: t }, async () => { const op = await policyOp(addr, 4); const gp = read(path.join(art, 'treasury.abi')).methods.get_policy; op.call_contract.entry_point = gp.entry_point ?? gp['entry-point']; return quorumTx([op]); });
      // A10 — chain binding at the kernel
      await runCase('A10-mainnet-chain-id', 'header.chain_id = Mainnet, re-signed, submitted to the testnet', { expectedCodes: [-1], expectedMessage: CHAINID, mutation: 'chain_id = Mainnet', signers: qa, payer: t }, async () => quorumTx([await transferOp(t, to, 1)], { chainId: MAINNET_CHAIN }));
      // Positive control: the live treasury state is still as expected (policy v0, balance untouched by all of the above).
      const pol = (await c.functions.get_policy({})).result; const ctrl = { runId: RUN_ID, policyVersion: pol?.version, owners: pol?.owners, threshold: pol?.threshold, state: await state(t), expected: { policyVersion: '0', owners: addr, threshold: 3 } };
      ctrl.verdict = String(pol?.version) === '0' && JSON.stringify(pol?.owners) === JSON.stringify(addr) && Number(pol?.threshold) === 3 ? 'pass' : 'fail';
      write(path.join(AUDIT, 'matrix-control.json'), ctrl); console.log('CONTROL ' + ctrl.verdict + ': policy version ' + ctrl.policyVersion + ', threshold ' + ctrl.threshold + ', treasury nonce ' + ctrl.state.nonce + ', balance ' + ctrl.state.balance);
      if (ctrl.verdict !== 'pass') process.exit(1);
      const failed = cases.filter(x => x.verdict !== 'pass'); console.log(`MATRIX ${cases.length - failed.length}/${cases.length} pass` + (failed.length ? ' FAILED: ' + failed.map(x => x.caseId).join(', ') : ''));
      if (failed.length) process.exit(1); break;
    }
    case 'replay': { // A5a: the exact bytes of an executed quorum payment (approved package from the CLI run)
      const pkg = read(args[0]); const keys = read(keysFile); const t = keys.treasury.address;
      const tx = pkg.transaction; assert(tx && tx.id && tx.signatures?.length >= 3, 'approved package with signatures expected');
      const inc = await rpc('transaction_store.get_transactions_by_id', { transaction_ids: [tx.id] });
      assert(inc.result?.transactions?.[0]?.containing_blocks?.length, 'the package transaction must already be included');
      await runCase('A5-replay', 'resubmit the exact bytes of the executed payment', { expectedCodes: [-201], expectedMessage: NONCE, mutation: 'none (byte-identical replay)', signers: ['package signers'], payer: t }, async () => tx);
      const failed = cases.filter(x => x.verdict !== 'pass'); if (failed.length) process.exit(1); break;
    }
    case 'allowance': { // A11: an outsider-paid approval on the fresh attack address (treasury nonce stays 0); the CLI must then refuse to bootstrap it
      const F = funder(args[0]); const a = read(path.join(W, 'attack.json')).attack; const A = Signer.fromWif(a.wif);
      const before = await state(a.address);
      const t = await sign(await build(F.getAddress(), [await koin.encodeOperation({ name: 'approve', args: { owner: a.address, spender: F.getAddress(), value: '100000000' } })], { rcLimit: '20000000' }), F, A);
      fs.writeFileSync(path.join(AUDIT, 'tx-A11-approval.json'), JSON.stringify(t, null, 1), { mode: 0o600 }); // persisted BEFORE the send
      write(path.join(AUDIT, 'case-A11-allowance.json'), { caseId: 'A11-allowance-before-upload', runId: RUN_ID, transactionId: t.id, admission: null, verdict: 'inconclusive' });
      const r = await submit(t); write(path.join(AUDIT, 'case-A11-allowance.json'), { caseId: 'A11-allowance-before-upload', runId: RUN_ID, transactionId: t.id, admission: r.admission, observed: r, verdict: 'inconclusive' });
      assert.equal(r.admission, 'accepted', 'approval must be accepted: ' + JSON.stringify(r).slice(0, 200));
      let incl; try { incl = await waitIncluded(t.id, true, t); } catch (e) { write(path.join(AUDIT, 'case-A11-allowance.json'), { caseId: 'A11-allowance-before-upload', runId: RUN_ID, transactionId: t.id, admission: r.admission, observed: r, error: String(e.message), verdict: 'inconclusive' }); throw e; }
      const allowance = (await koin.functions.allowance({ owner: a.address, spender: F.getAddress() })).result?.value || '0';
      const after = await state(a.address);
      const rec = { caseId: 'A11-allowance-before-upload', runId: RUN_ID, objective: 'outsider-paid KOIN approval on the fresh address before any upload', transactionId: t.id, admission: 'accepted', block: incl.blockId, height: incl.height, irreversible: incl.irreversible, canonicalLookup: incl.canonicalLookup, bodyMatchesSubmitted: incl.bodyMatchesSubmitted, reverted: incl.reverted, rc_used: incl.receipt?.rc_used, payer: F.getAddress(), signers: [F.getAddress(), a.address], allowance, state: { before, after }, verdict: allowance === '100000000' && after.nonce === '0' ? 'pass' : 'fail' };
      cases.push(rec); write(path.join(AUDIT, 'case-A11-allowance.json'), rec);
      console.log(`${rec.verdict.toUpperCase().padEnd(12)} A11: allowance ${allowance} on ${a.address}, nonce ${after.nonce} (CLI refusal checked separately)`);
      if (rec.verdict !== 'pass') process.exit(1); break;
    }
    case 'proofs': { // canonical execution evidence by ledger ROLE + balance/Mana reconciliation (treasury, recipient, funder)
      const ev = read(args[0]); const stepId = pat => { const st = ev.steps.find(x => pat.test(x.name)); return st?.id || st?.bootstrapId || null; };
      const fundingFile = path.join(AUDIT, 'funding.json'); const ledger = fs.existsSync(fundingFile) ? read(fundingFile) : { entries: [] };
      const a11 = path.join(AUDIT, 'case-A11-allowance.json'); const a11rec = fs.existsSync(a11) ? read(a11) : null;
      const roles = [];
      ledger.entries.forEach((e, i) => roles.push({ role: 'funding-' + (i + 1), id: e.transactionId, submitted: read(path.join(AUDIT, `tx-fund-${i + 1}.json`)) }));
      const pkg = n => fs.existsSync(path.join(W, n)) ? read(path.join(W, n)).transaction : null;
      roles.push({ role: 'bootstrap', id: stepId(/^prepare-deploy/), submitted: pkg('deploy.signed.json') });
      roles.push({ role: 'payment-1', id: stepId(/^A13b payment/), submitted: pkg('payment-1.approved.json') });
      roles.push({ role: 'rotation', id: stepId(/^rotation/), submitted: pkg('policy-1.approved.json') });
      roles.push({ role: 'payment-2', id: stepId(/^post-rotation payment/), submitted: pkg('payment-2.approved.json') });
      roles.push({ role: 'A11-approval', id: a11rec?.transactionId || null, submitted: fs.existsSync(path.join(AUDIT, 'tx-A11-approval.json')) ? read(path.join(AUDIT, 'tx-A11-approval.json')) : null });
      const head = await headInfo(); const proofs = [];
      for (const r of roles) {
        const proof = { role: r.role, transactionId: r.id, ok: false };
        if (!r.id || !r.submitted) { proof.problem = 'missing id or submitted body'; proofs.push(proof); continue; }
        const c = await canonicalInclusion(r.id, head, Infinity, r.submitted);
        if (!c.blockId) { proof.problem = 'no canonical inclusion'; proof.containingBlocks = c.containingBlocks; proofs.push(proof); continue; }
        Object.assign(proof, { containingBlocks: c.containingBlocks, block: { id: c.blockId, height: c.height, previous: c.item.block?.header?.previous, timestamp: c.item.block?.header?.timestamp, signer: c.item.block?.header?.signer },
          canonicalLookup: c.canonicalLookup, heightsConsistent: c.heightsConsistent, anchorsConsistent: c.anchorsConsistent, irreversible: c.irreversible, bodyMatchesSubmitted: c.bodyMatchesSubmitted,
          transaction: c.body ? { ...c.body, signedSha256: sha(JSON.stringify(c.body)) } : null, receipt: c.receipt ? { ...c.receipt, logs: (c.receipt.logs || []).map(x => redact(x)) } : null, ok: c.ok });
        proof.decodedTransferEvents = []; for (const e of (c.receipt?.events || [])) { const te = await transferEvent(e); if (te) proof.decodedTransferEvents.push(te); }
        if (!c.ok) proof.problem = 'verifier: ' + JSON.stringify({ heightsConsistent: c.heightsConsistent, anchorsConsistent: c.anchorsConsistent, irreversible: c.irreversible, reverted: c.reverted, bodyMatchesSubmitted: c.bodyMatchesSubmitted });
        proofs.push(proof);
      }
      // Reconciliation. Treasury: exact balance; Mana within [max(0, balance - rc_used), balance] (payments are already reflected in the
      // balance; regeneration deliberately not modeled = conservative lower bound). Recipient: exact. Funder: exact balance (approvals move no balance).
      const keys = read(keysFile); const t = keys.treasury.address; const final = await state(t);
      const byRole = Object.fromEntries(proofs.map(x => [x.role, x]));
      const fundedRaw = ledger.entries.filter(e => e.to === t).reduce((s, e) => s + BigInt(e.raw), 0n);
      // Exactly one decoded KOIN transfer event from the treasury to the recipient per payment; its integer amount must equal the CLI's claim.
      const payments = ['payment-1', 'payment-2'].map(rl => {
        const evs = (byRole[rl]?.decodedTransferEvents || []).filter(x => x.from === t && x.to === keys.recipient.address);
        const step = ev.steps.find(x => x.id === byRole[rl]?.transactionId);
        return { role: rl, eventValue: evs.length === 1 ? BigInt(evs[0].value) : null, eventCount: evs.length, claimed: step?.recipientCredit ? rawAmount(step.recipientCredit) : 0n };
      });
      const paymentsRaw = payments.reduce((s, x) => s + (x.eventValue ?? x.claimed), 0n);
      const chargesRaw = proofs.filter(x => x.transaction?.header?.payer === t && x.receipt).reduce((s, x) => s + BigInt(x.receipt.rc_used || 0), 0n);
      const expectedBalance = fundedRaw - paymentsRaw; const lower = BigInt(final.balance) - chargesRaw;
      const recipientBalance = String(await balance(keys.recipient.address));
      const funderFinal = ledger.funder ? await state(ledger.funder) : null; const funderExpected = ledger.funderInitialBalance ? String(BigInt(ledger.funderInitialBalance) - ledger.entries.reduce((s, e) => s + BigInt(e.raw), 0n)) : null;
      // Funder Mana: charged only by its own canonical transactions (fundings, A11 approval); regeneration can only raise it -> conservative bounds.
      const funderCharges = proofs.filter(x => ledger.funder && x.transaction?.header?.payer === ledger.funder && x.receipt).reduce((s, x) => s + BigInt(x.receipt.rc_used || 0), 0n);
      // max(0, initialMana - outflows - rc_used) <= finalMana <= finalBalance: a transfer spends Mana equal to its amount, rc_used is charged, regeneration only adds.
      const funderOutflows = ledger.entries.reduce((s, e) => s + BigInt(e.raw), 0n); const funderInitialMana = ledger.funderInitialMana ? BigInt(ledger.funderInitialMana) : null;
      const funderLower = funderInitialMana === null ? null : (funderInitialMana - funderOutflows - funderCharges > 0n ? funderInitialMana - funderOutflows - funderCharges : 0n);
      const funderManaOk = funderFinal && funderLower !== null ? BigInt(funderFinal.rc) <= BigInt(funderFinal.balance) && BigInt(funderFinal.rc) >= funderLower : false;
      const accounting = { treasury: t, fundedRaw: String(fundedRaw), payments: payments.map(x => ({ role: x.role, eventValue: x.eventValue === null ? null : String(x.eventValue), eventCount: x.eventCount, claimedByCli: String(x.claimed), consistent: x.eventValue !== null && x.eventValue === x.claimed })),
        paymentsRaw: String(paymentsRaw), expectedBalance: String(expectedBalance), finalBalance: final.balance, balanceExact: final.balance === String(expectedBalance),
        rcUsedByTreasuryRaw: String(chargesRaw), finalMana: final.rc, manaBound: 'max(0, balance - rc_used) <= Mana <= balance', manaWithinBounds: BigInt(final.rc) <= BigInt(final.balance) && BigInt(final.rc) >= (lower > 0n ? lower : 0n), finalNonce: final.nonce,
        recipient: { address: keys.recipient.address, finalBalance: recipientBalance, expected: String(paymentsRaw), exact: recipientBalance === String(paymentsRaw) },
        funder: { address: ledger.funder || null, initialBalance: ledger.funderInitialBalance || null, finalBalance: funderFinal?.balance ?? null, expected: funderExpected, exact: funderFinal !== null && funderFinal.balance === funderExpected, initialMana: ledger.funderInitialMana || null, finalMana: funderFinal?.rc ?? null, outflowsRaw: String(funderOutflows), rcUsedByFunderRaw: String(funderCharges), manaBound: 'max(0, initialMana - outflows - rc_used) <= finalMana <= finalBalance', manaLowerBound: funderLower === null ? null : String(funderLower), manaWithinBounds: funderManaOk } };
      const out = { schema: 1, runId: RUN_ID, head: { height: head.head_topology.height, lib: head.last_irreversible_block, id: head.head_topology.id, time: head.head_block_time }, treasuryFinalState: final, accounting, proofs };
      write(path.join(W, 'proofs.json'), out);
      const bad = proofs.filter(x => !x.ok); const paymentsOk = accounting.payments.every(x => x.consistent) && accounting.funder.manaWithinBounds;
      console.log(`PROOFS ${proofs.length - bad.length}/${proofs.length} roles canonical, irreversible, anchored, not reverted, body = submitted; balance exact: ${accounting.balanceExact}; Mana within bounds: ${accounting.manaWithinBounds}; recipient exact: ${accounting.recipient.exact}; funder exact: ${accounting.funder.exact}; payment events = CLI claims: ${paymentsOk}` + (bad.length ? ' PROBLEM: ' + bad.map(x => x.role + (x.problem ? ' (' + x.problem + ')' : '')).join(', ') : ''));
      if (bad.length || !accounting.balanceExact || !accounting.manaWithinBounds || !accounting.recipient.exact || !accounting.funder.exact || !paymentsOk) process.exit(1); break;
    }
    case 'summary': {
      const files = fs.readdirSync(AUDIT).filter(f => f.startsWith('case-')).sort(); const all = files.map(f => read(path.join(AUDIT, f)));
      const tally = { pass: 0, fail: 0, inconclusive: 0 }; for (const c of all) tally[c.verdict] = (tally[c.verdict] || 0) + 1;
      write(path.join(W, 'audit-summary.json'), { schema: 1, cases: all.map(c => ({ caseId: c.caseId, verdict: c.verdict, expected: c.expected?.codes, observedCode: c.observed?.code ?? null, admission: c.observed?.admission ?? null })), tally });
      console.log('SUMMARY ' + JSON.stringify(tally)); if (tally.fail || tally.inconclusive) process.exit(1); break;
    }
    default: throw Error('unknown action');
  }
})().then(() => process.exit(0)).catch(e => { console.error('audit driver failed: ' + redact(e.message || e).slice(0, 400)); process.exit(1); });
