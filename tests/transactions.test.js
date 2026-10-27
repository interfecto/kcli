// Only disposable encrypted wallets and loopback RPCs are used in this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Serializer, Signer, utils } = require('koilib');
const tokenAbi = require('../src/abis/token.json');
const pobAbi = require('../src/abis/pob.json');

const signer = Signer.fromSeed('kcli disposable release transaction fixture; never fund');
const recipient = Signer.fromSeed('kcli disposable release recipient; never fund').getAddress();
const networks = {
  mainnet: { chainId: 'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==',
    koin: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK', vhp: '12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq', pob: '159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv' },
  testnet: { chainId: 'EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==',
    koin: '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju', pob: '1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9' },
};

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcli-transaction-release-'));
  const walletDir = path.join(home, '.kcli');
  fs.mkdirSync(walletDir, { mode: 0o700 });
  const password = 'disposable-release-fixture-password';
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(signer.getPrivateKey('wif'), 'utf8'), cipher.final()]).toString('hex');
  fs.writeFileSync(path.join(walletDir, 'wallet.json'), JSON.stringify({ address: signer.getAddress(), encryptedKey: {
    encrypted, salt: salt.toString('hex'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'),
  } }), { mode: 0o600 });
  const passwordFile = path.join(walletDir, 'fixture-password');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  const token = new Serializer(tokenAbi.koilib_types);
  const calls = [], submitted = [];
  const blockId = `0x1220${'de'.repeat(32)}`;
  const server = http.createServer(async (request, response) => {
    let rpc;
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      rpc = JSON.parse(body); calls.push(rpc);
      if (rpc.method === options.failMethod) throw new Error('Synthetic RPC read failure');
      let result;
      if (rpc.method === 'chain.get_chain_id') result = { chain_id: options.chainId || networks.mainnet.chainId };
      else if (rpc.method === 'chain.get_account_nonce') result = { nonce: 'KAA=' };
      else if (rpc.method === 'chain.get_account_rc') result = { rc: options.mana ?? '10000000000' };
      else if (rpc.method === 'chain.read_contract') {
        const [name, method] = Object.entries(tokenAbi.methods).find(([, method]) => method.entry_point === rpc.params.entry_point) || [];
        assert.ok(method, 'Unexpected read method');
        if (name === 'decimals' && options.failDecimals) throw new Error('Synthetic decimals read failure');
        const value = name === 'name' ? 'Synthetic release token' : name === 'symbol' ? 'SYN' : name === 'decimals' ? (options.decimals ?? 8) : options.balance ?? '10000000000';
        result = { result: utils.encodeBase64url(await token.serialize({ value }, method.return)) };
      } else if (rpc.method === 'chain.submit_transaction') {
        const tx = rpc.params.transaction;
        assert.equal(tx.header.chain_id, options.chainId || networks.mainnet.chainId);
        assert.deepEqual(await Signer.recoverAddresses(tx), [signer.getAddress()]);
        submitted.push(tx);
        result = { receipt: { id: tx.id, payer: tx.header.payer, logs: [] } };
      } else if (rpc.method === 'transaction_store.get_transactions_by_id') {
        result = { transactions: [{ containing_blocks: [blockId] }] };
      } else if (rpc.method === 'chain.get_head_info') {
        result = { head_topology: { id: blockId, height: '123' } };
      } else if (rpc.method === 'block_store.get_blocks_by_id' || rpc.method === 'block_store.get_blocks_by_height') {
        result = { block_items: [{ block_id: blockId, block_height: '123' }] };
      } else throw new Error('Unexpected fixture RPC method');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id, error: { code: -1, message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, passwordFile, calls, submitted, url: `http://127.0.0.1:${server.address().port}/` };
}

async function run(f, args, network = 'mainnet') {
  const child = spawn('kcli', ['--network', network, '--rpc', f.url, ...args, '--password-file', f.passwordFile], {
    env: { ...process.env, HOME: f.home, KOINOS_BASEDIR: f.home, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, output);
    assert.ok(!output.includes(signer.getPrivateKey('wif')), 'Synthetic WIF must never appear in CLI output');
    return output;
  } finally { clearTimeout(timer); child.kill('SIGTERM'); }
}

for (const command of ['transfer', 'token-transfer']) {
  test(`${command} dry-run preserves explicit nonce and token amount without submission`, async t => {
    const f = await fixture(t);
    const args = command === 'transfer' ? [command, recipient, '1.25'] : [command, networks.mainnet.koin, recipient, '1.25'];
    const output = await run(f, [...args, '--nonce', 'KAc=', '--dry-run']);
    assert.match(output, /Nonce: KAc=/);
    assert.match(output, /RC Limit: 1000000000/);
    assert.match(output, /NOT signed or submitted/);
    const encoded = output.match(/Args \(base64\): (\S+)/)[1];
    const operation = await new Serializer(tokenAbi.koilib_types).deserialize(encoded, tokenAbi.methods.transfer.argument);
    assert.deepEqual(operation, { from: signer.getAddress(), to: recipient, value: '125000000' });
    assert.equal(f.calls.filter(call => call.method === 'chain.get_account_nonce').length, 0);
    assert.equal(f.submitted.length, 0);
  });
}

// A disposable address that is neither the configured KOIN nor VHP contract.
const customToken = Signer.fromSeed('kcli disposable custom token contract; never fund').getAddress();

for (const [label, args] of [
  ['transfer', ['transfer', recipient, '1']],
  ['token-transfer to the configured KOIN contract', ['token-transfer', networks.mainnet.koin, recipient, '1']],
  ['token-transfer to the configured VHP contract', ['token-transfer', networks.mainnet.vhp, recipient, '1']],
]) {
  test(`${label} refuses RPC decimals that disagree with the fixed 8 before signing or submission`, async t => {
    const f = await fixture(t, { decimals: 10 });
    const output = await run(f, [...args, '--yes', '--no-wait']);
    assert.match(output, /reports 10 decimals for the configured system token, expected 8/);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.calls.filter(call => call.method === 'chain.get_account_nonce').length, 0);
  });
}

test('transfer refuses an empty decimals result for the configured KOIN contract', async t => {
  const f = await fixture(t, { decimals: 0 });
  const output = await run(f, ['transfer', recipient, '1', '--yes', '--no-wait']);
  assert.match(output, /reports 0 decimals for the configured system token, expected 8/);
  assert.equal(f.submitted.length, 0);
});

test('transfer encodes 1 KOIN as exactly 100000000 base units and shows them in the summary', async t => {
  const f = await fixture(t);
  const output = await run(f, ['transfer', recipient, '1', '--dry-run']);
  assert.match(output, /Amount: 1 SYN \(100000000 base units, 8 decimals\)/);
  const encoded = output.match(/Args \(base64\): (\S+)/)[1];
  const operation = await new Serializer(tokenAbi.koilib_types).deserialize(encoded, tokenAbi.methods.transfer.argument);
  assert.equal(operation.value, '100000000');
  assert.equal(f.submitted.length, 0);
});

test('token-transfer of a custom token uses its reported decimals, including zero', async t => {
  const f = await fixture(t, { decimals: 0, balance: '10' });
  const output = await run(f, ['token-transfer', customToken, recipient, '3', '--dry-run']);
  assert.match(output, /Amount: 3 SYN \(3 base units, 0 decimals\)/);
  const encoded = output.match(/Args \(base64\): (\S+)/)[1];
  const operation = await new Serializer(tokenAbi.koilib_types).deserialize(encoded, tokenAbi.methods.transfer.argument);
  assert.equal(operation.value, '3');
  assert.equal(f.submitted.length, 0);
});

test('token-transfer of a custom token refuses unreadable or unsupported decimals', async t => {
  const unreadable = await fixture(t, { failDecimals: true });
  let output = await run(unreadable, ['token-transfer', customToken, recipient, '1', '--yes', '--no-wait']);
  assert.match(output, /Could not read the token decimals/);
  assert.equal(unreadable.submitted.length, 0);

  const tooMany = await fixture(t, { decimals: 19 });
  output = await run(tooMany, ['token-transfer', customToken, recipient, '1', '--yes', '--no-wait']);
  assert.match(output, /unsupported decimals: 19/);
  assert.equal(tooMany.submitted.length, 0);
});

test('transfer --no-wait submits one exact synthetic transaction and skips inclusion and balance readback', async t => {
  const f = await fixture(t);
  const output = await run(f, ['transfer', recipient, '1', '--nonce', 'KAc=', '--no-wait', '--yes']);
  assert.match(output, /Skipped confirmation wait/);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].header.nonce, 'KAc=');
  assert.equal(f.calls.filter(call => call.method === 'transaction_store.get_transactions_by_id').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'chain.read_contract' && call.params.entry_point === tokenAbi.methods.balance_of.entry_point).length, 1);
});

test('transfer default wait still verifies inclusion and reads both updated balances', async t => {
  const f = await fixture(t);
  const output = await run(f, ['transfer', recipient, '1', '--yes']);
  assert.match(output, /confirmed in block 123/);
  assert.match(output, /Updated Balances/);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].header.nonce, 'KAE=');
  assert.ok(f.calls.some(call => call.method === 'transaction_store.get_transactions_by_id'));
  assert.equal(f.calls.filter(call => call.method === 'chain.read_contract' && call.params.entry_point === tokenAbi.methods.balance_of.entry_point).length, 3);
});

test('transfer refuses mainnet/testnet chain mismatches before signing or submission', async t => {
  for (const selected of Object.keys(networks)) {
    const other = selected === 'mainnet' ? 'testnet' : 'mainnet';
    const f = await fixture(t, { chainId: networks[other].chainId });
    const output = await run(f, ['transfer', recipient, '1', '--no-wait', '--yes'], selected);
    assert.match(output, /does not match the selected network/);
    assert.equal(f.submitted.length, 0);
  }
});

test('transfer controls never bypass balance, Mana or failed-read checks', async t => {
  for (const [options, reason] of [[{ balance: '1' }, /Insufficient token balance/], [{ mana: '1' }, /Insufficient mana/],
    [{ failMethod: 'chain.get_account_rc' }, /Error transferring tokens/]]) {
    const f = await fixture(t, options);
    const output = await run(f, ['transfer', recipient, '1', '--nonce', 'KAc=', '--no-wait', '--yes']);
    assert.match(output, reason);
    assert.equal(f.submitted.length, 0);
  }
});

test('producer registration dry-run uses network PoB contract and ten percent of available Mana', async t => {
  const publicKey = utils.encodeBase64url(signer.publicKey);
  for (const network of Object.keys(networks)) {
    const f = await fixture(t, { chainId: networks[network].chainId });
    const output = await run(f, ['register-producer-key', signer.getAddress(), publicKey, '--dry-run'], network);
    assert.match(output, /RC Limit: 1000000000/);
    assert.ok(output.includes(`Contract: ${networks[network].pob}`));
    const encoded = output.match(/Args \(base64\): (\S+)/)[1];
    const args = await new Serializer(pobAbi.koilib_types).deserialize(encoded, pobAbi.methods.register_public_key.argument);
    assert.deepEqual(args, { producer: signer.getAddress(), public_key: publicKey });
    assert.equal(f.submitted.length, 0);
  }
});

test('producer registration refuses a wrong mainnet chain before submission', async t => {
  const f = await fixture(t, { chainId: networks.testnet.chainId });
  const output = await run(f, ['register-producer-key', signer.getAddress(), utils.encodeBase64url(signer.publicKey), '--yes']);
  assert.match(output, /does not match the selected network/);
  assert.equal(f.submitted.length, 0);
});
