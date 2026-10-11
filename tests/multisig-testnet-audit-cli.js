// Installed-CLI audit phases on the official testnet (test-only keys): the real workflow with the released kcli plus
// the finality / one-shot observations that the plain rehearsal does not record.
// usage: KCLI_ROOT=<installed candidate checkout> NETWORK=testnet node multisig-testnet-audit-cli.js <phase> <work dir> <rpc>
// phases: deploy (A13a: verify-deployment before finality writes no manifest) | operate1 (payment with --wait 5,
//         reconcile to finality, A12: resend refused, second HOME submit refused, second HOME reconcile finds it)
//         | operate2 (rotation by the old quorum, payment by the new quorum) | allowance (A11: prepare-deploy refuses
//         an address with a pre-existing allowance)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ROOT = process.env.KCLI_ROOT; assert(ROOT && fs.existsSync(path.join(ROOT, 'dist', 'index.js')), 'set KCLI_ROOT to the installed candidate checkout');
const { Contract, Provider } = require(path.join(ROOT, 'node_modules', 'koilib'));
const MP = require(path.join(ROOT, 'dist', 'multisig-protocol')); // balance reads only; the independent oracle is multisig-testnet-audit.cjs
const [phase, W, rpc] = process.argv.slice(2);
assert(['deploy', 'operate1', 'operate2', 'allowance'].includes(phase) && W && rpc === 'https://testnet.koinosfoundation.org/jsonrpc' && process.env.NETWORK === 'testnet', 'usage: <phase> <work dir> <official testnet rpc> with NETWORK=testnet');
const T = { pay1: '0.5', pay1Raw: '50000000', pay2: '0.1', pay2Raw: '10000000', minBalance: 500000000n, wait: '600', timeout: '120' };
const DEPLOY_RC = process.env.DEPLOY_RC || '100000000', CALL_RC = process.env.CALL_RC || '20000000';
const password = 'synthetic-exercise-only-password';
const keys = JSON.parse(fs.readFileSync(path.join(W, 'keys.json'), 'utf8'));
const evidenceFile = path.join(W, 'evidence-cli.json');
const evidence = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : { schema: 1, networkProfile: 'testnet', publicChainUsed: true, syntheticOnly: true, independentCustody: false, runId: process.env.RUN_ID || null, kcli: { version: spawnSync('kcli', ['--version'], { encoding: 'utf8' }).stdout.trim(), distIndexSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'dist', 'index.js'))).digest('hex') }, steps: [] };
const record = (name, data = {}) => { evidence.steps.push({ name, ...data }); fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log('PASS ' + name); };
const home = name => { const d = path.join(W, 'homes', name); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); return d; };
const coordinator = home('coordinator');
const memberHome = i => home('member-' + i);
const docs = out => out.trim() ? out.split(/\n(?=\{)/).filter(Boolean).map(x => JSON.parse(x)) : []; // strict: malformed stdout throws
const AUDIT = path.join(W, 'audit'); fs.mkdirSync(AUDIT, { recursive: true, mode: 0o700 });
const logCommand = (h, argv, r) => fs.appendFileSync(path.join(AUDIT, 'cli-commands.jsonl'), JSON.stringify({ at: new Date().toISOString(), home: path.basename(h), argv: argv.map(a => a.startsWith(W) ? a.slice(W.length + 1) : a), exit: r.status, stdout: r.stdout, stderr: r.stderr }) + '\n', { mode: 0o600 });
function run(h, argv) { // any exit code; the caller decides. kcli prints its result JSON on stdout for exit 0 AND 3.
  const r = spawnSync('kcli', argv, { cwd: W, encoding: 'utf8', env: { ...process.env, HOME: h }, timeout: 1500000 });
  logCommand(h, argv, r);
  return { status: r.status, docs: docs(r.stdout), stdout: r.stdout, stderr: r.stderr };
}
// Exit 0 and 3 must carry a status-bearing JSON document on stdout; exit 1 reports on stderr.
const statusOf = r => { const st = r.docs.map(d => d.status).filter(Boolean).pop(); if (r.status === 0 || r.status === 3) { assert(st, `exit ${r.status} without a status document: ${r.stdout}${r.stderr}`); return st; } return (r.stderr.trim().split('\n').pop() || '').slice(0, 160); };
function kcli(h, argv, expect = 0) {
  const r = run(h, argv);
  assert.equal(r.status, expect, `kcli ${argv.slice(0, 2).join(' ')} exited ${r.status}: ${r.stderr}`);
  return expect === 0 ? r.docs : r.stderr;
}
function pty(h, argv, inputs) {
  const r = spawnSync('python3', [path.join(ROOT, 'tests', 'vortex-pty.py')], { input: JSON.stringify({ home: h, argv: ['kcli', ...argv], inputs }), encoding: 'utf8', timeout: 400000, cwd: W });
  const reply = JSON.parse(r.stdout); assert.equal(reply.leaked, false, 'synthetic secret escaped terminal output');
  assert.equal(reply.status, 0, 'kcli failed under PTY: ' + reply.stdout.slice(-600)); return reply;
}
const importWallet = (h, name, wif) => pty(h, ['wallets', 'import', name], [{ prompt: 'Import WIF (hidden): ', value: wif }, { prompt: 'New wallet password: ', value: password }, { prompt: 'Confirm wallet password: ', value: password }]);
const online = ['--network', 'testnet', '--rpc', rpc];
async function koinBalance(address) {
  const provider = new Provider(rpc); const c = new Contract({ id: keys.koin, abi: MP.KOIN_ABI, provider });
  const { result } = await c.functions.balance_of({ owner: address }); return BigInt(result?.value || '0');
}
function memberSign(i, file, manifest, id, signer = keys.owners[i]) {
  const local = path.join(memberHome(i), path.basename(file)); fs.copyFileSync(file, local);
  const review = kcli(memberHome(i), ['multisig', 'inspect', local, '--manifest', manifest])[0];
  assert.equal(review.id, id, 'member sees the same exact ID');
  const out = path.join(W, path.basename(file, '.json') + `.member-${i}.json`);
  pty(memberHome(i), ['multisig', 'sign', local, '--manifest', manifest, '--wallet', 'member', '--signer', signer.address, '--id', id, '--out', out], [{ prompt: 'Wallet password: ', value: password }]);
  return out;
}
const journalCount = h => { const d = path.join(h, '.kcli', 'multisig-journal'); const walk = x => fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(path.join(x, e.name)) : 1), 0) : 0; return walk(d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function reconcileUntilFinal(h, pkg, manifest, extra = []) { // poll the read-only reconciliation until finality (<= 10 min)
  const timeline = []; const deadline = Date.now() + 600000;
  for (;;) {
    if (Date.now() + 65000 > deadline) throw Error('INCONCLUSIVE: finality not reached within 10 minutes (timeline ' + JSON.stringify(timeline) + ')');
    const r = run(h, ['multisig', 'reconcile', pkg, '--manifest', manifest, ...online, '--timeout', '60', ...extra]); const status = statusOf(r);
    timeline.push({ at: new Date().toISOString(), exit: r.status, status });
    if (r.status === 0) return { result: r.docs.find(d => d.status) || r.docs[0], timeline };
    assert.equal(r.status, 3, 'reconcile must only be non-final (3) or final (0) here: ' + r.stderr); await sleep(Math.min(10000, Math.max(0, deadline - 65000 - Date.now())));
  }
}

async function deploy() {
  importWallet(coordinator, 'treasury-bootstrap', keys.treasury.wif);
  keys.owners.forEach((o, i) => importWallet(memberHome(i), 'member', o.wif));
  importWallet(memberHome(5), 'member', keys.future.wif);
  record('wallets: bootstrap key and six members imported into separate HOMEs through hidden PTY input');
  const artifact = path.join(W, 'artifact'); const manifestOut = path.join(W, 'treasury.json');
  const prepared = kcli(coordinator, ['multisig', 'prepare-deploy', '--artifact', artifact, ...online, '--rc-limit', DEPLOY_RC, '--out', path.join(W, 'deploy.json')])[0];
  assert.equal(prepared.status, 'prepared'); assert.deepEqual(prepared.owners, keys.owners.map(o => o.address)); assert.deepEqual(prepared.flags, { call: true, transaction: true, upload: true });
  const inspected = kcli(coordinator, ['multisig', 'inspect-deploy', path.join(W, 'deploy.json')])[0]; assert.equal(inspected.id, prepared.id);
  record('prepare-deploy + inspect-deploy: unused address checked, single upload with all three flags, exact artifact hashes', { bootstrapId: prepared.id, wasmSha256: prepared.wasmSha256 });
  const wrong = kcli(memberHome(0), ['multisig', 'sign-deploy', path.join(W, 'deploy.json'), '--wallet', 'member', '--signer', keys.owners[0].address, '--id', prepared.id, '--out', path.join(W, 'x.json')], 1);
  assert.match(wrong, /treasury address/);
  pty(coordinator, ['multisig', 'sign-deploy', path.join(W, 'deploy.json'), '--wallet', 'treasury-bootstrap', '--signer', keys.treasury.address, '--id', prepared.id, '--out', path.join(W, 'deploy.signed.json')], [{ prompt: 'Wallet password: ', value: password }]);
  const dry = kcli(coordinator, ['multisig', 'submit-deploy', path.join(W, 'deploy.signed.json'), ...online, '--dry-run'])[0]; assert.equal(dry.preflight, 'passed'); assert.equal(dry.submitted, false);
  // A13a: a one-second wait cannot reach finality on the public chain; the bootstrap is pending, not failed.
  const sent = run(coordinator, ['multisig', 'submit-deploy', path.join(W, 'deploy.signed.json'), ...online, '--id', prepared.id, '--wait', '1']);
  const sentStatus = statusOf(sent);
  assert([0, 3].includes(sent.status), 'submit-deploy --wait 1 must be pending (3) or, exceptionally, final (0): ' + sent.stdout + sent.stderr);
  if (sent.status === 3) assert.match(sentStatus, /^(included|submitted-unconfirmed)$/); else assert.equal(sentStatus, 'irreversible');
  const early = run(coordinator, ['multisig', 'verify-deployment', path.join(W, 'deploy.signed.json'), ...online, '--wait', '1', '--timeout', '60', '--manifest-out', manifestOut]);
  const earlyStatus = statusOf(early);
  assert([0, 3].includes(early.status), 'early verify-deployment must be non-final (3) or, exceptionally, final (0): ' + early.stdout + early.stderr);
  if (early.status === 3) { assert.match(earlyStatus, /^(included-not-irreversible|observation-not-irreversible|unknown)$/); assert(!fs.existsSync(manifestOut), 'no manifest may exist while the bootstrap is not final'); }
  else assert.equal(earlyStatus, 'deployment-verified');
  const pendingExercised = sent.status === 3 && early.status === 3; // legitimate early finality means the pending branch was not observed
  record('A13a submit-deploy --wait 1 and immediate verify-deployment: pending outcomes carry exit 3 and write no manifest', { verdict: pendingExercised ? 'pass' : 'not-exercised (chain already final)', submitExit: sent.status, submitStatus: sentStatus, earlyVerifyExit: early.status, earlyVerifyStatus: earlyStatus, manifestExistedEarly: fs.existsSync(manifestOut) });
  // verify-deployment does not wait for a reversible bootstrap (MULTISIG_FINALITY_FIX.md): poll the read-only verification until final (<= 15 min).
  const vt = []; let verified = early.status === 0 ? (early.docs.find(d => d.status) || early.docs[0]) : null; const vdeadline = Date.now() + 900000;
  while (!verified) {
    // A pending (reversible) bootstrap makes verify-deployment return at once; once the bootstrap is final, the invocation waits for
    // observation finality for --wait seconds, which must therefore be long enough (up to 600 s) and fit the remaining global budget.
    const remaining = vdeadline - Date.now(); if (remaining < 130000) throw Error('INCONCLUSIVE: bootstrap finality not reached within the 15-minute deadline (timeline ' + JSON.stringify(vt) + ')');
    const wait = String(Math.max(60, Math.min(600, Math.floor(remaining / 1000) - 70)));
    const r = run(coordinator, ['multisig', 'verify-deployment', path.join(W, 'deploy.signed.json'), ...online, '--wait', wait, '--timeout', '60', '--manifest-out', manifestOut]);
    const st = statusOf(r); vt.push({ at: new Date().toISOString(), exit: r.status, status: st });
    if (r.status === 0) { verified = r.docs.find(d => d.status) || r.docs[0]; break; }
    assert.equal(r.status, 3, 'verify-deployment must only be pending (3) or final (0) here: ' + r.stdout + r.stderr); assert.match(st, /^(included-not-irreversible|observation-not-irreversible|unknown)$/);
    assert(!fs.existsSync(manifestOut), 'no manifest while not final'); await sleep(Math.min(10000, Math.max(0, vdeadline - Date.now())));
  }
  assert.equal(verified.status, 'deployment-verified'); assert(fs.existsSync(manifestOut), 'manifest written at deployment-verified');
  assert.equal(verified.checks.policySpaceEmpty, true); assert.equal(verified.checks.nonce, '1'); assert.equal(verified.checks.allowances, 0); assert.deepEqual(verified.checks.flags, { call: true, transaction: true, upload: true, system: false });
  record('verify-deployment: code + metadata hash, flags, empty policy space, policy v0, nonce 1, no allowances, read at one block that then became irreversible -> manifest written', { manifestSha256: verified.manifestSha256, block: verified.block, height: verified.height, timeline: vt });
  const again = kcli(coordinator, ['multisig', 'submit-deploy', path.join(W, 'deploy.signed.json'), ...online, '--id', prepared.id], 1);
  assert.match(again, /already paid|intent|contract/);
  record('a second bootstrap submission is refused');
}

async function operate1() {
  const manifest = path.join(W, 'treasury.json');
  const info = kcli(coordinator, ['multisig', 'info', '--manifest', manifest, ...online])[0];
  assert.equal(info.policy.version, '0'); assert(BigInt(info.balance) >= T.minBalance, 'funded after verification');
  record('info: verified code/flags/policy; balance and Mana read', { balance: info.balance, mana: info.mana, nonce: info.nonce });
  const before = await koinBalance(keys.recipient.address);
  const p1 = kcli(coordinator, ['multisig', 'prepare-transfer', '--manifest', manifest, ...online, '--to', keys.recipient.address, '--amount', T.pay1, '--rc-limit', CALL_RC, '--note', 'audit payment 1', '--out', path.join(W, 'payment-1.json')])[0];
  assert.equal(p1.action.amount, T.pay1); assert.equal(p1.action.raw, T.pay1Raw); assert.equal(p1.status, 'prepared');
  const refusedOutsider = kcli(memberHome(5), ['multisig', 'sign', path.join(W, 'payment-1.json'), '--manifest', manifest, '--wallet', 'member', '--signer', keys.future.address, '--id', p1.id, '--out', path.join(W, 'y.json')], 1);
  assert.match(refusedOutsider, /not a current owner/);
  const signed = [0, 1, 2].map(i => memberSign(i, path.join(W, 'payment-1.json'), manifest, p1.id));
  const partial = kcli(coordinator, ['multisig', 'merge', signed[0], signed[1], '--manifest', manifest, '--out', path.join(W, 'payment-1.partial.json')])[0]; assert.equal(partial.status, 'partial');
  const tooFew = kcli(coordinator, ['multisig', 'submit', path.join(W, 'payment-1.partial.json'), '--manifest', manifest, ...online, '--dry-run'], 1); assert.match(tooFew, /Missing owner approvals/);
  const approved = path.join(W, 'payment-1.approved.json');
  const merged = kcli(coordinator, ['multisig', 'merge', ...signed, '--manifest', manifest, '--out', approved])[0]; assert.equal(merged.status, 'quorum-ready');
  const dry = kcli(coordinator, ['multisig', 'submit', approved, '--manifest', manifest, ...online, '--dry-run']); assert.equal(dry[1].submitted, false);
  // A13b: a five-second wait on the public chain; pending (3) or already final (0) are both legitimate, never 1.
  const j0 = journalCount(coordinator);
  const sub = run(coordinator, ['multisig', 'submit', approved, '--manifest', manifest, ...online, '--id', p1.id, '--timeout', T.timeout, '--wait', '5']);
  const subStatus = statusOf(sub);
  assert([0, 3].includes(sub.status), 'submit --wait 5 must be pending (3) or, exceptionally, final (0): ' + sub.stdout + sub.stderr);
  if (sub.status === 3) assert.match(subStatus, /^(included|submitted-unconfirmed)$/); else assert.equal(subStatus, 'irreversible-and-verified');
  const j1 = journalCount(coordinator); assert(j1 > j0, 'journal entries written before/at the single send');
  const fin = await reconcileUntilFinal(coordinator, approved, manifest);
  assert.equal(fin.result.status, 'irreversible-and-verified'); assert.equal(fin.result.transferEvent.to, keys.recipient.address); assert.equal(fin.result.transferEvent.value, T.pay1Raw);
  assert.equal(await koinBalance(keys.recipient.address) - before, BigInt(T.pay1Raw));
  record('A13b payment: 3 member signatures, merge, dry-run, submit --wait 5, reconciled to irreversible-and-verified with the exact event', { id: p1.id, verdict: sub.status === 3 ? 'pass' : 'pending branch not exercised (already final)', submitExit: sub.status, submitStatus: subStatus, block: fin.result.block, timeline: fin.timeline, recipientCredit: T.pay1 });
  // A12a: the same HOME never resends; the journal does not grow.
  const resend = kcli(coordinator, ['multisig', 'submit', approved, '--manifest', manifest, ...online, '--id', p1.id], 1); assert.match(resend, /stale or already used|intent/);
  assert.equal(journalCount(coordinator), j1, 'resend attempt must not add journal entries');
  // A12b/c: a second coordinator (fresh HOME) with the same approved package: submit is refused by the fresh preflight (stale nonce), reconcile finds the canonical inclusion.
  const second = home('second-coordinator');
  const other = run(second, ['multisig', 'submit', approved, '--manifest', manifest, ...online, '--id', p1.id, '--wait', '5']);
  assert.equal(other.status, 1, 'second HOME submit of an executed package must be refused: ' + other.stdout); assert.equal(journalCount(second), 0, 'refused before any journal write'); assert.match(other.stderr, /stale|nonce|already|intent/i);
  const otherRec = kcli(second, ['multisig', 'reconcile', approved, '--manifest', manifest, ...online])[0]; assert.equal(otherRec.status, 'irreversible-and-verified'); assert.equal(otherRec.block, fin.result.block);
  record('A12 (post-inclusion, stale-nonce refusal): resend refused without journal growth; a second HOME cannot submit the executed package and its reconcile finds the same canonical inclusion', { resendReason: resend.trim().split('\n').pop().slice(0, 120), secondHomeSubmitReason: other.stderr.trim().split('\n').pop().slice(0, 120) });
}

async function operate2() {
  const manifest = path.join(W, 'treasury.json');
  const nextOwners = [...keys.owners.slice(1).map(o => o.address), keys.future.address];
  fs.writeFileSync(path.join(W, 'policy.json'), JSON.stringify({ owners: nextOwners, threshold: 3 }), { mode: 0o600 });
  const pp = kcli(coordinator, ['multisig', 'prepare-policy', '--manifest', manifest, ...online, '--policy', path.join(W, 'policy.json'), '--rc-limit', CALL_RC, '--out', path.join(W, 'policy-1.json')])[0];
  assert.equal(pp.action.kind, 'policy');
  const ps = [0, 3, 4].map(i => memberSign(i, path.join(W, 'policy-1.json'), manifest, pp.id));
  const pm = kcli(coordinator, ['multisig', 'merge', ...ps, '--manifest', manifest, '--out', path.join(W, 'policy-1.approved.json')])[0]; assert.equal(pm.status, 'quorum-ready');
  const rotated = kcli(coordinator, ['multisig', 'submit', path.join(W, 'policy-1.approved.json'), '--manifest', manifest, ...online, '--id', pp.id, '--wait', T.wait])[0];
  assert.equal(rotated.status, 'irreversible-and-verified'); assert.equal(rotated.policy.version, '1');
  const snap = kcli(coordinator, ['multisig', 'reconcile', path.join(W, 'policy-1.approved.json'), '--manifest', manifest, ...online, '--manifest-out', path.join(W, 'treasury-v1.json')])[0];
  assert.equal(snap.status, 'irreversible-and-verified');
  const stale = kcli(coordinator, ['multisig', 'info', '--manifest', manifest, ...online], 1); assert.match(stale, /policy differs/);
  const v1 = path.join(W, 'treasury-v1.json'); const info1 = kcli(coordinator, ['multisig', 'info', '--manifest', v1, ...online])[0]; assert.equal(info1.policy.version, '1');
  record('rotation: replacement approved by the old quorum, irreversible, new manifest snapshot; old manifest refused', { id: pp.id, block: rotated.block, manifestSha256: snap.manifestSha256 });
  const p2 = kcli(coordinator, ['multisig', 'prepare-transfer', '--manifest', v1, ...online, '--to', keys.recipient.address, '--amount', T.pay2, '--rc-limit', CALL_RC, '--out', path.join(W, 'payment-2.json')])[0];
  const removed = kcli(memberHome(0), ['multisig', 'sign', path.join(W, 'payment-2.json'), '--manifest', v1, '--wallet', 'member', '--signer', keys.owners[0].address, '--id', p2.id, '--out', path.join(W, 'z.json')], 1);
  assert.match(removed, /not a current owner/);
  const s2 = [memberSign(5, path.join(W, 'payment-2.json'), v1, p2.id, keys.future), memberSign(3, path.join(W, 'payment-2.json'), v1, p2.id), memberSign(4, path.join(W, 'payment-2.json'), v1, p2.id)];
  const m2 = kcli(coordinator, ['multisig', 'merge', ...s2, '--manifest', v1, '--out', path.join(W, 'payment-2.approved.json')])[0]; assert.equal(m2.status, 'quorum-ready');
  const done2 = kcli(coordinator, ['multisig', 'submit', path.join(W, 'payment-2.approved.json'), '--manifest', v1, ...online, '--id', p2.id, '--wait', T.wait])[0];
  assert.equal(done2.status, 'irreversible-and-verified'); assert.equal(done2.transferEvent.value, T.pay2Raw);
  assert.equal(kcli(coordinator, ['multisig', 'reconcile', path.join(W, 'payment-2.approved.json'), '--manifest', v1, ...online])[0].status, 'irreversible-and-verified');
  const crossManifest = kcli(coordinator, ['multisig', 'inspect', path.join(W, 'payment-1.json'), '--manifest', v1], 1); assert.match(crossManifest, /different manifest/);
  record('post-rotation payment: removed member refused, new quorum (incl. new member) pays and reconciles; old packages bind the old manifest', { id: p2.id, block: done2.block, recipientCredit: T.pay2 });
}

async function allowance() { // A11 CLI side: the pre-approved fresh address must never be accepted as a treasury
  const r = run(coordinator, ['multisig', 'prepare-deploy', '--artifact', path.join(W, 'artifact-attack'), ...online, '--rc-limit', DEPLOY_RC, '--dry-run']);
  assert.equal(r.status, 1, 'prepare-deploy must refuse an address with a KOIN allowance: ' + r.stdout);
  assert.match(r.stderr, /allowance/i);
  record('A11 prepare-deploy refuses the pre-approved address (allowance before upload)', { reason: r.stderr.trim().split('\n').pop().slice(0, 160) });
}

({ deploy, operate1, operate2, allowance })[phase]().then(() => console.log(phase.toUpperCase() + ' COMPLETE')).catch(e => { console.error('CLI audit failed: ' + String(e.message).replace(/\b[5KL][1-9A-HJ-NP-Za-km-z]{49,51}\b/g, '[redacted-key]').slice(0, 1500)); process.exit(1); });
