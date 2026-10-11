# Multisig treasury: official-testnet audit suite (opt-in)

End-to-end audit of the released `kcli multisig` commands on the official Koinos testnet with real
transactions. It is not part of `npm test`, never touches Mainnet and uses test-only keys and tKOIN. It
extends `multisig-testnet-rehearsal.sh` with an independent adversarial matrix against the live treasury,
the released CLI's complete lifecycle including its pending and finality paths, canonical-inclusion proofs
for every accepted transaction and an exact tKOIN accounting.

## Files

| File | Runs on | Purpose |
|---|---|---|
| `multisig-testnet-audit.sh` | host | Orchestrator: builds, funds, drives the phases below, enforces the budget, stages public evidence, confirms removal of the funder key copy |
| `multisig-testnet-audit.cjs` | kcli container | Independent oracle (koilib + raw JSON-RPC, imports nothing from `dist/`): `fund`, `matrix`, `replay`, `attack-keys`, `allowance`, `proofs`, `summary` |
| `multisig-testnet-audit-cli.js` | kcli container | Released-CLI phases: `deploy`, `operate1`, `operate2`, `allowance` |
| `multisig-testnet-tools.cjs` | kcli container | Existing rehearsal helper, reused for keys, estimates and artifact handling |
| `multisig-audit-index.py` | host | Run manifest, sanitization scan and recursive SHA-256 index of the evidence |
| `multisig-mainnet-readonly-check.cjs` | anywhere | Mainnet read-only check of the two-RPC finality helper: five allowlisted read requests per endpoint, no submission |

## What the testnet run checks

- Release identity: the container's `dist/` is compared file by file with the extracted GitHub release
  tarball before anything is signed.
- Adversarial matrix A1–A10, 31 submissions, each expected to be refused with an exact kernel code: the
  treasury's address key alone (transfer, `set_policy`, tiny upload) and as co-signer of an outsider-paid
  full-size upload; two of five owners; the same signature twice and two distinct signatures by one owner;
  quorum plus a non-owner, a high-s signature, a wrong-length signature; a nonce gap; memo, two transfers,
  treasury or a signing owner as payee, treasury paying for another account's transfer, outsider payer;
  quorum `approve` and `burn`; uploads paid by the treasury or by an outsider; seven invalid `set_policy`
  shapes and a wrong entry point; the Mainnet chain id. Every refused case checks that the balance is
  unchanged and that Mana did not decrease net of regeneration; a read-back control then confirms
  policy v0 and records the state.
- Exact replay of an executed payment (A5); a KOIN allowance granted to a fresh address before its upload,
  which `prepare-deploy` must refuse (A11); resubmission after inclusion, refused by the same coordinator
  home without journal growth and by a second home in preflight, whose read-only reconcile then finds the
  original inclusion (A12); `submit-deploy --wait 1` and `submit --wait 5` on the public chain (A13: a
  pending result, exit 3, is reconciled to irreversible-and-verified, `verify-deployment` before finality
  writes no manifest; exit 0 is accepted when the block is already final).
- Lifecycle with the released CLI: bootstrap, `verify-deployment`, payment, owner rotation, second payment
  under the new policy, every step through the journal.
- Proofs: for every accepted transaction the canonical block (all containing blocks, head lookup by id and
  height, block and receipt anchors, included body equal to the submitted one, receipt not reverted, at or
  below the last irreversible block), decoded transfer events, the balances of treasury, recipient and
  funder reconciled exactly, and treasury and funder Mana within conservative bounds.

## Prerequisites and budget

Same environment as the rehearsal script: Docker, a kcli container (default `msig-kcli`: this release
checkout with `kcli` on PATH, tmpfs `/dev/shm`, `python3`; tested with Node 22, which is recorded, not
enforced), a contract builder container (default `msig-builder`) and `python3` on the host. In addition the
extracted release tarball's `dist/` at `RELEASE_TGZ_DIST` (default `/deps/audit-tgz/v1.7.1/package/dist`)
and a funder key file: a regular file with mode 0600, one hard link, owned by the invoking user, read
without following symlinks, holding JSON with matching `wif` and `address`. The precheck requires a funder
balance of at least 25 tKOIN; a run spends up to 16 (10 provisioned for the upload, 5 for the payments, 1
for the allowance). The kcli container joins
Docker's default bridge network for the run only and is detached afterwards.

## Running

```bash
tests/multisig-testnet-audit.sh <evidence dir> <funder key json> [builder] [kcli container]
```

About 20 minutes. Exit 0 leaves public evidence only: `run.json`, one record per case, proofs, the CLI
command log and `index.json` with the SHA-256 of every other evidence file; keys, wallets and homes are
never exported. On failure the partial evidence lands in `<evidence dir>.failed` with `run-partial.json`,
and the container workspaces are retained so provisioned tKOIN can be recovered. `KEEP=1` retains them
after success too.

```bash
KCLI_ROOT=<built kcli checkout> node tests/multisig-mainnet-readonly-check.cjs <out.json> [primary RPC] [witness RPC]
```

Imports `koilib` and `dist/vortex-network` from that checkout. Exit 0 pass, 1 regression, 2 inconclusive;
the evidence file is always written. The witness may be a local tunnel to a node you operate
(`M1_TUNNEL_WITNESS=1`, `http://host.docker.internal:<port>/`), which is recorded as such and does not
demonstrate operator independence.

## Result of the 11 October 2026 run (kcli 1.7.1)

`dist/` identical to the GitHub release tarball (64 files). 33 records: 33 pass, 0 fail, 0 inconclusive.
32 refused submissions with the expected codes (A1–A10 and the replay), 7 canonical irreversible
transactions (two fundings, bootstrap, two payments, rotation, the A11 approval), accounting exact at
85 tKOIN (70 funder, 14.4 treasury, 0.6 recipient). The Mainnet read-only check passed with
`api.koinos.io` as primary and a node operated by the auditor as witness. The evidence is available on
request; nothing from it is needed to run the suite.
