# kcli - Koinos CLI

Current version: `1.7.1`

A command line tool for interacting with the Koinos blockchain, built with TypeScript and koilib.

## Installation

The GitHub release includes a compiled Node.js package, not a standalone native
binary. Use Node.js 22 and npm; runtime dependencies are installed by npm.

```bash
npm install -g https://github.com/pgarciagon/kcli/releases/download/v1.7.1/kcli-1.7.1.tgz
kcli --version
```

Alternatively, build the tagged source:

```bash
git clone --branch v1.7.1 --depth 1 https://github.com/pgarciagon/kcli.git
cd kcli
npm ci
npm run build
npm link
```

See [release notes, verification and limitations](RELEASE_NOTES.md). GitHub
distribution does not imply that a package was published to the npm registry.

## Development

Run in development mode:

```bash
npm run dev -- <command>
# or after linking:
kcli <command>
```

Run the dashboard, KFS, wallet/Vortex, multisig, transaction and derivation regression tests:

```bash
npm test
```

Vortex V2 restricted local/mainnet administration is included in 1.6.0. Named
encrypted wallets and detached-signing commands are described in the
[CLI administrator guide](VORTEX_ADMINISTRATOR_GUIDE.md); the
[implementation status](VORTEX_IMPLEMENTATION_STATUS.md) distinguishes tests
from actual contract execution. These workflows do not use Kondor or a custom
administration website and do not modify the existing default wallet/config.
The opt-in fresh-chain exercise is documented separately; `npm test` does not
start Docker or operate a public chain. Mainnet requires an authenticated reviewed
manifest, an explicitly trusted review-key fingerprint and two independently
operated reviewed HTTPS RPCs. No mainnet deployment or real custody is qualified
by these development tests. Public testnet Vortex profiles remain unsupported.

## Multisig Treasury

A contract-enforced N-of-M KOIN treasury (`kcli multisig ...`) is included in kcli 1.7.0: an immutable
treasury contract template (independently versioned 1.0.0) in
[contracts/multisig-treasury](contracts/multisig-treasury/README.md), offline inspect/sign/merge with named
wallets, fresh-preflight one-shot submission and irreversible reconciliation. It was exercised on
disposable local chains and rehearsed once on the official testnet with synthetic test-only keys on one machine.
Read the [operating guide](MULTISIG_TREASURY_GUIDE.md) and the
[implementation status](MULTISIG_IMPLEMENTATION_STATUS.md) before any use; no external security audit, real custody or
Mainnet qualification exists yet.

Both reviewed Mainnet RPCs must cover the transaction block with their irreversible heights before
terminal success or reversion. Normal reversible inclusion keeps waiting; deadlines never cause an
automatic resend. See [finality statuses and exit codes](MULTISIG_FINALITY_FIX.md) and
[release validation and limitations](MULTISIG_RELEASE_VALIDATION.md).

## Build

```bash
npm run build
```

## Usage

### Global Options

- `-n, --network <network>` - Network to use (`mainnet` or `testnet`)
- `-r, --rpc <url>` - RPC endpoint URL override
- `-c, --changes` - Show latest changes and exit

### Commands

#### Get Chain Info
```bash
kcli chain-info
kcli --network testnet chain-info
```

#### Get Block Content
```bash
kcli block <height>           # By block height
kcli block 1000000
kcli block <blockId>          # By block ID
kcli block --full 1000000     # Show full transaction details
```

#### Check KOIN/VHP/Mana Balance
```bash
kcli balance <address>
kcli balance 1NsQbH5AhQXgtSNg1ejpFqTi2hmCWz1eQS
```

#### Check VHP Balance
```bash
kcli vhp <address>
```

#### Check Any Token Balance (KCS-4)
```bash
kcli token-balance <contractId> <address>
```

#### Transfer KOIN
```bash
kcli transfer <to> <amount>
kcli transfer <to> <amount> --dry-run
kcli transfer <to> <amount> --password-file ~/.kcli/wallet-password.txt --yes
kcli transfer <to> <amount> --no-wait --nonce KAE= --password-file ~/.kcli/wallet-password.txt --yes
kcli --network testnet transfer <to> 10
```

Transfers KOIN from the encrypted wallet imported with `kcli import-wallet`. The command shows transaction details before signing and requires typing `TRANSFER` to confirm.
Use `--password-file <path>` with a local `0600` file for non-interactive automation, and `--yes` only when you intentionally want to skip the confirmation prompt.
Use `--no-wait` when an external regression runner will verify inclusion separately. Use `--nonce <base64url>` only when the caller controls nonce sequencing, for example when submitting a deliberate mempool-pressure burst.

#### Transfer Any Token (KCS-4)
```bash
kcli token-transfer <contractId> <to> <amount>
kcli token-transfer <contractId> <to> <amount> --dry-run
kcli token-transfer <contractId> <to> <amount> --password-file ~/.kcli/wallet-password.txt --yes
kcli token-transfer <contractId> <to> <amount> --no-wait --nonce KAI= --password-file ~/.kcli/wallet-password.txt --yes
```

Transfers any KCS-4 token from the encrypted wallet. The token contract is queried for name, symbol and decimals before building the transaction. For the configured KOIN and VHP contracts the amount is always encoded with 8 decimals; if the RPC reports a different value the command refuses to transfer. For other tokens the reported decimals must be readable and between 0 and 18, otherwise the command refuses. The transfer summary shows the amount in base units next to the decimal amount.

#### Koinos Fund System Proposals and Votes

```bash
kcli fund-info
kcli proposals --status active --all
kcli proposals --status upcoming --json
kcli proposals --status past --order date
kcli proposal <id>
kcli votes [address]
kcli vote <id> --percent 50 --dry-run
kcli vote <id> --percent 50
kcli vote <id> --percent 0  # Remove an existing vote
```

These commands target Koinos Fund System (KFS) projects. Block-producer voting on
protocol upgrades is a separate mechanism. Mainnet defaults to fund contract
`1A5BmMqV5jN5zBrdkhQumAfDZBzXLPBeN9`. The CLI checks the RPC chain ID against
the selected network and validates RPC ABI metadata before use, except for the
explicitly read-only fallback described below.

Read commands support `--json`, which preserves raw integer amounts and
timestamps. `votes` uses the supplied address, the imported wallet's public
address, or the configured default account, in that order, without unlocking.
`proposals` defaults to active projects ordered by votes, highest first.
Use `--limit <1-100>` for a bounded page, `--cursor <returned-cursor>` to continue,
`--all` for all pages, and `--ascending` to reverse the order. Past projects can
only be ordered by date.

Since 1.7.1, if the RPC
returns no ABI for the known Mainnet KFS address, read commands can use the
bundled `src/abis/fund-read.json` interface. This contains only four read methods,
with entry points and protobuf fields checked against upstream
[fund.proto](https://github.com/koinos/koinos-contracts-as/blob/4fc33bbe0520a77a89619da1e9e6efe98e7c423c/contracts/fund/assembly/proto/fund.proto)
and its [dispatcher](https://github.com/koinos/koinos-contracts-as/blob/4fc33bbe0520a77a89619da1e9e6efe98e7c423c/contracts/fund/assembly/index.ts).
This is interface compatibility, not deployed-bytecode verification.

The fallback requires the actual Mainnet chain ID and exact default KFS address;
it does not apply to testnet or other deployments. Compatible RPC metadata stays
preferred; incompatible/malformed metadata and RPC failures remain errors.
An empty ABI index does not prove that the contract is missing. Read output
adds `abi_source` (`rpc-metadata` or `bundled-read-only`); fallback notices go to
stderr so `--json` stdout remains parseable. Empty protobuf lists are valid,
including omitted default bytes in a successful JSON-RPC result object. A
missing JSON-RPC result envelope is an error, not evidence of no proposals or votes.
No additional/public RPC is contacted automatically, and no index rebuild,
service restart or configuration change is needed for these reads.

Both `vote` and its `--dry-run` still require compatible RPC ABI metadata and
cannot use the bundled interface. For voting, explicitly select a correctly
indexed RPC on the same network; switching a read RPC is not permission to sign.

Since 1.7.1, fund reads use strict response validation while accepting protobuf defaults:
`get_user_votes` can return an empty protobuf message when there are no votes.
The RPC's successful result payload may be `{}` or contain only valid `logs`,
because [Proto3 JSON omits default fields](https://protobuf.dev/programming-guides/json/#presence-and-default-values).
The [chain RPC schema](https://github.com/koinos/koinos-proto/blob/master/koinos/rpc/chain/chain_rpc.proto)
defines the nested `result` as an implicit-presence bytes field. kcli now decodes
that omission as empty bytes instead of failing with `Fund get_user_votes read
returned no result.` This applies to fund reads and vote preparation, without
relaxing chain-ID, ABI, allocation or signing checks. Standard and URL-safe
base64, with or without padding, are validated before decoding. Missing outer
RPC results, null/non-object payloads, malformed logs/bytes and RPC failures
remain errors and cannot silently turn an unknown allocation into an empty list.

See [fund RPC compatibility, examples and validation limits](FUND_RPC_COMPATIBILITY.md).

Vote allocations use KOIN plus VHP balances, in steps of 5%, with a maximum total
allocation of 100%. Updating a project's percentage replaces its previous
allocation; repeating it renews expiration; zero removes it. Recorded expired
allocations still count toward the contract's allocation budget until updated or
removed. Voting does not transfer your tokens, but requires available mana.

Dry-runs prepare an unsigned transaction without unlocking the wallet or reading
a password file. They do not simulate contract execution. An explicit public
address can be used without an imported wallet:

```bash
kcli --network mainnet --rpc https://api.koinos.io vote <id> \
  --percent 50 --address <public-address> --dry-run
```

A signed vote uses the imported encrypted wallet and requires typing `VOTE`.
For controlled automation, use `--password-file <0600-file>` and `--yes`.
The default RC limit is 10% of available mana; `--rc-limit <base-units>` sets a
positive limit no greater than available mana (100,000,000 base units = 1 mana).
After submission, the CLI waits for inclusion, checks the block receipt, and
reads the allocation back. Inclusion is not irreversible finality. An error or
timeout after submission must be investigated before retrying. `--no-wait`
returns after submission without verifying inclusion or readback, and
`--wait-timeout <1-300>` adjusts the default 60-second inclusion wait.

No default fund deployment is configured for the official testnet. Use
`--fund-contract <address>` only for a verified compatible deployment on the
selected chain; it does not bypass the chain-ID or ABI checks. The integration
uses [KPS](https://github.com/Armana-group/kps) as an interface reference, with an
independent CLI implementation, an ABI fetched from RPC metadata, and the
restricted read-only fallback above.

Validation includes synthetic signed voting tests, live mainnet reads, and
unsigned preparation. A public-chain vote/update/removal round trip remains
unverified.

#### Official Testnet Info
```bash
kcli testnet-info
kcli faucet-info
```

Official Koinos Foundation testnet details:

- JSON-RPC: `https://testnet.koinosfoundation.org/jsonrpc`
- Health: `https://testnet.koinosfoundation.org/health`
- Chain ID: `EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==`
- KOIN contract: `1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju`
- VHP contract: `17n12ktwN79sR6ia9DDgCfmw77EgpbTyBi`
- PoB contract: `1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9`
- Faucet: `https://t.me/KoinosTestnetFaucetBot`

To request testnet vKOIN, open the Telegram faucet and send:

```txt
/faucet YOUR_KOINOS_ADDRESS
```

The testnet can reset. Do not use it for production funds or durable production state.

#### Generate New Wallet
```bash
kcli generate-wallet
```

#### Derive Kondor-Compatible Accounts from Seed
```bash
kcli derive-from-seed "<seed phrase>" --num-accounts 5
```

#### Get Address from Private Key
```bash
kcli address <privateKeyWIF>
```

#### Get Account Nonce
```bash
kcli nonce <address>
```

#### Get Resource Credits (Mana)
```bash
kcli rc <address>
```

#### Read Contract Method
```bash
kcli read-contract <contractId> <method> --args '{"key": "value"}'
kcli read-contract 15DJN4a8SgrbGhhGksSBASiSYjGnMU8dGL name
```

#### Import Encrypted Wallet
```bash
kcli import-wallet <privateKeyWIF>
```

#### Show Current Wallet
```bash
kcli wallet
```

#### Delete Stored Wallet
```bash
kcli delete-wallet
```

#### Register Producer Public Key (PoB)
```bash
kcli register-producer-key <producerAddress> <publicKey>
kcli register-producer-key <publicKey>  # Uses configured main producer address
kcli register-producer-key 14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb Aq4Ps_Ch-f8OZDnpQOov2SiMvdYyA5tn0oWa36QWnTeH
kcli register-producer-key <producerAddress> <publicKey> --dry-run
kcli register-producer-key <producerAddress> <publicKey> --password-file ~/.kcli/wallet-password.txt --yes
```

This command sends a transaction to the Proof-of-Burn contract (`159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv`) and calls `register_public_key`.

- `producerAddress`: address that will produce blocks
- `publicKey`: block producer public key in base64url format (typically from `$KOINOS_BASEDIR/block_producer/public.key`)
- `--dry-run`: prepare and display the transaction without sending it
- `--password-file <path>`: read the wallet password from a local `0600` file
- `--yes`: skip the confirmation prompt

If the producer address is omitted, `kcli` uses `mainProducerAddress` from `~/.kcli/config.json`.

#### Get Registered Producer Public Key (PoB)
```bash
kcli get-producer-key <producerAddress>
kcli get-producer-key              # Uses configured main producer address
```

This command reads PoB `get_public_key` and returns the public key assigned to the producer address (if any).

#### Producer Dashboard (Interactive)
```bash
kcli producer-dashboard
kcli producer-dashboard --window 240 --interval 3 --top 25
kcli producer-dashboard --view peers
kcli producer-dashboard --balance-interval 30 --pool-interval 600 --rpc-concurrency 2 --rpc-stats
```

Shows a live text-based dashboard with two views: `producers` and `peers`.

- `--window`: number of recent blocks to analyze (default: `120`)
- `--interval`: screen and producer-activity refresh interval in seconds (default: `5`); it does not refetch every balance
- `--top`: number of producers to display (default: `20`)
- `--view`: initial view (`producers` or `peers`, default: `producers`)
- `--balance-interval`: balance and total-supply polling interval, `1-3600` seconds (default: `30`)
- `--pool-interval`: pool polling interval, `1-86400` seconds (default: `600`)
- `--rpc-concurrency`: dashboard-only request and HTTP socket limit, `1-4` (default: `2`)
- `--rpc-timeout`: absolute timeout per RPC attempt, `1-60` seconds (default: `10`)
- `--rpc-retries`: additional attempts for recoverable reads, `0-3` (default: `2`, exponential backoff with jitter)
- `--rpc-stats`: cumulative request attempts, errors, retries, concurrency and socket counters
- Switch views while running with `1` (producers) and `2` (peers)
- Exit with `q` or `Ctrl+C`
- Includes per-producer `KOIN` and `VHP` columns (shown as whole numbers, no decimals)
- Shows estimated APY only when every active producer's VHP and both token supplies are available; stale inputs produce a labeled stale estimate
- Shows total virtual supply (`VHP + KOIN`)
- Detects Fogata pools by calling `get_pool_params`; highlights those producer addresses in orange and shows pool `name`
- Peers view shows active peer endpoint (IP:port), geolocation, ping in seconds, seen ratio, and a role heuristic (`Seed`, `Likely Producer`, `Possible Producer`, `Relay/Unknown`)
- Seed detection uses local node `p2p.peer` config entries when available (`$KOINOS_BASEDIR/config/config.yml`, `~/.koinos/config/config.yml`, `~/.koinos/config.yml`, `/etc/koinos/config.yml`)
- Geolocation is best-effort using `ipwho.is`; role classification is heuristic (not an on-chain proof)
- Block window fetch is automatically paginated, so `--window` can be greater than `1000`

Reads are staggered and cached in memory by network, endpoint, contract, method
and arguments. KOIN and VHP update independently. Temporary failures retain the
last successful value with `stale:<age>`; `n/a` means no valid value is available,
never zero. Pool errors mean unknown, not proof that an address is not a pool.
The screen keeps updating during slow reads, without overlapping activity scans
or accumulating polling rounds. The dashboard's own HTTP/HTTPS agent reuses at
most the configured number of sockets and closes idle sockets after one second.
Other commands and their transports are unchanged.

Thirty seconds trades block-by-block balance accuracy for substantially fewer
reads; the screen shows the oldest available balance age. Pool names normally
change much less frequently, so their default remains ten minutes. These are
polling targets, not freshness guarantees: startup, many producers, slow RPCs or
retries can delay results. Cached balances and APY are not head-anchored and must
not be used as transaction preflight. See [dashboard reliability and measured
validation](DASHBOARD_RPC_RELIABILITY.md) for limitations and reproducible checks.

#### Burn KOIN to Receive VHP
```bash
kcli burn -p 95        # Burn 95% of KOIN balance
kcli burn -a 10        # Burn exactly 10 KOIN
kcli burn -p 95 --dry-run
kcli burn -a 10 --password-file ~/.kcli/wallet-password.txt --yes
```

#### Config
```bash
kcli config --show
kcli config --network testnet
kcli config --rpc https://testnet.koinosfoundation.org/jsonrpc
kcli config --default-account <address>
kcli config --main-producer-address <address>
```

Default main producer address:

```txt
14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb
```

### Using Custom RPC

```bash
kcli --rpc http://localhost:8080 chain-info
kcli --network testnet --rpc http://localhost:8080 chain-info
```

### Using the Official Testnet

Use the testnet for one command:

```bash
kcli --network testnet chain-info
kcli --network testnet balance <address>
kcli --network testnet token-balance 1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju <address>
```

Or make it the default:

```bash
kcli config --network testnet
kcli chain-info
```

`balance`, `vhp`, `burn`, producer key, and producer dashboard commands use the official testnet KOIN, VHP, and PoB contract IDs when `--network testnet` is selected.

### Show Latest Changes

```bash
kcli --changes
```
