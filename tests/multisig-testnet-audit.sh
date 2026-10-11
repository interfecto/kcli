#!/usr/bin/env bash
# Separately authorized official-testnet AUDIT run (test-only keys and tKOIN; never Mainnet). Extends the rehearsal with
# the independent adversarial matrix on the live treasury, the finality/one-shot observations and canonical proofs.
# usage: multisig-testnet-audit.sh <evidence dir> <funder key json> [builder] [kcli container]
# The kcli container joins Docker's default network only for this run (public testnet RPC) and leaves it after.
# Budget (hard): 10 tKOIN provisioning for the upload, 5 tKOIN for payments, 1 tKOIN allowance; rejections cost nothing.
set -euo pipefail
EVIDENCE=${1:?evidence dir}; FUNDER=${2:?funder key json}; BUILDER=${3:-msig-builder}; KCLI=${4:-msig-kcli}
ROOT=$(cd "$(dirname "$0")/.." && pwd); RUN=audit-$(date -u +%Y%m%d%H%M%S); STARTED_AT=$(date -u +%FT%TZ)
K=/deps/$RUN; B=/work/$RUN; RPC=https://testnet.koinosfoundation.org/jsonrpc
FKEY=/dev/shm/$RUN-funder.json   # container tmpfs, never the writable layer
RELEASE_TGZ_DIST=${RELEASE_TGZ_DIST:-/deps/audit-tgz/v1.7.1/package/dist}   # extracted GitHub release tarball (verified by SHA256SUMS)
[ ! -e "$EVIDENCE" ] && [ ! -e "$EVIDENCE.partial" ] && [ ! -e "$EVIDENCE.failed" ] || { echo 'evidence dir exists; refuse overwrite' >&2; exit 2; }
# The funder key is read ONCE through a no-follow descriptor that is validated (regular, 0600, one link, ours).
read_funder() {
  python3 -I -c 'import os,stat,sys
fd=os.open(sys.argv[1], os.O_RDONLY|os.O_NOFOLLOW); st=os.fstat(fd)
assert stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_uid==os.getuid(), "funder key must be a private regular file (0600, one link, yours)"
sys.stdout.buffer.write(os.read(fd, 65536))' "$FUNDER"
}
CREATED_K=0; CREATED_B=0; JOINED=0; KEY_PLACED=0; STAGED=0; CLEANUP_FAILED=0; KCLI_SHA=""; KCLI_VERSION=""; TREASURY=""
cleanup() {
  if [ "$KEY_PLACED" = 1 ]; then # removal must be positively confirmed; an unreachable container counts as failure
    docker exec "$KCLI" rm -f -- "$FKEY" || true
    if ! docker exec "$KCLI" test ! -e "$FKEY"; then echo "WARNING: the funder key copy $FKEY in container $KCLI could NOT be confirmed removed; remove it by hand" >&2; CLEANUP_FAILED=1; fi
  fi
  # Forensics on failure: public evidence only (never keys.json / wallets / homes); always a partial manifest + recursive index.
  if [ "$STAGED" = 0 ]; then
    mkdir -p "$EVIDENCE.failed"
    [ "$CREATED_K" = 1 ] && { docker exec "$KCLI" sh -c "cd $K && tar -cf - --ignore-failed-read audit evidence-cli.json proofs.json independent.json deploy.signed.json payment-1.approved.json policy-1.approved.json payment-2.approved.json treasury.json treasury-v1.json 2>/dev/null" | tar -C "$EVIDENCE.failed" -xf - 2>/dev/null || true; }
    RUN_ID="$RUN" STARTED_AT="$STARTED_AT" KCLI_SHA="$KCLI_SHA" KCLI_VERSION="$KCLI_VERSION" TREASURY="$TREASURY" python3 -I "$ROOT/tests/multisig-audit-index.py" "$EVIDENCE.failed" partial || true
    echo "run did not complete; partial public evidence in $EVIDENCE.failed" >&2
  fi
  [ "$JOINED" = 1 ] && { docker network disconnect bridge "$KCLI" || { echo 'WARNING: could not detach the kcli container from the bridge network' >&2; CLEANUP_FAILED=1; }; }
  # Workspaces (synthetic keys, packages, journals) are removed only after a complete, staged run with a clean cleanup; after a
  # failure they are retained for recovery of any provisioned tKOIN and for diagnosis (the funder key copy is removed regardless).
  if [ "$STAGED" = 1 ] && [ "$CLEANUP_FAILED" = 0 ] && [ "${KEEP:-0}" != 1 ]; then
    [ "$CREATED_K" = 1 ] && { docker exec "$KCLI" rm -r -- "$K" || { echo "WARNING: could not remove $KCLI:$K" >&2; CLEANUP_FAILED=1; }; }
    [ "$CREATED_B" = 1 ] && { docker exec "$BUILDER" rm -r -- "$B" || { echo "WARNING: could not remove $BUILDER:$B" >&2; CLEANUP_FAILED=1; }; }
  elif [ "$CREATED_K" = 1 ]; then echo "workspace retained: $KCLI:$K (and $BUILDER:$B)" >&2; fi
  [ "$CLEANUP_FAILED" = 0 ] || exit 3
}
trap cleanup EXIT
docker exec "$KCLI" test ! -e "$K" && docker exec "$BUILDER" test ! -e "$B" || { echo 'workspace exists' >&2; exit 2; }
docker exec "$KCLI" sh -c 'df -t tmpfs /dev/shm >/dev/null 2>&1' || { echo 'container /dev/shm is not tmpfs' >&2; exit 2; }
WORKTREE=$(docker exec "$KCLI" sh -c 'dirname $(dirname $(readlink -f $(which kcli)))')
KCLI_SHA=$(docker exec "$KCLI" sha256sum "$WORKTREE/dist/index.js" | cut -d' ' -f1); KCLI_VERSION=$(docker exec "$KCLI" kcli --version)
# The executed CLI must be the verified release: the complete dist/ tree (recursive path set and every file) identical to the
# extracted GitHub tarball's dist/. Arguments are passed positionally (no interpolation into the script).
DIST_TREE_SHA=$(docker exec -i "$KCLI" sh -s "$WORKTREE/dist" "$RELEASE_TGZ_DIST" <<'SH'
set -eu; A=$1; B=$2; T=$(mktemp -d)
( cd "$A" && find . -type f | LC_ALL=C sort ) > "$T/a"; ( cd "$B" && find . -type f | LC_ALL=C sort ) > "$T/b"
cmp -s "$T/a" "$T/b" || { echo "dist file sets differ:" >&2; diff "$T/a" "$T/b" >&2 || true; exit 1; }
[ "$(wc -l < "$T/a")" -gt 0 ] || { echo "empty dist" >&2; exit 1; }
while IFS= read -r f; do cmp -s "$A/$f" "$B/$f" || { echo "differs: $f" >&2; exit 1; }; done < "$T/a"
( cd "$A" && while IFS= read -r f; do sha256sum "$f"; done < "$T/a" | sha256sum | cut -d' ' -f1 )
rm -r -- "$T"
SH
) || { echo 'executed kcli is not the verified release build' >&2; exit 2; }
RUNTIME_ID=$(docker exec -i "$KCLI" sh -s "$WORKTREE" <<'SH'
echo "node=$(node --version) koilib=$(node -p "require(process.argv[1] + '/node_modules/koilib/package.json').version" "$1")"
SH
)
IMAGE_ID=$(docker inspect -f '{{.Image}}' "$KCLI")
echo "kcli $KCLI_VERSION ($RUNTIME_ID), dist/index.js sha256 $KCLI_SHA, dist tree $DIST_TREE_SHA, container image $IMAGE_ID; dist identical to the release tarball"
docker exec "$KCLI" mkdir -m 700 "$K"; CREATED_K=1; docker exec "$KCLI" mkdir -m 700 "$K/driver" "$K/artifact" "$K/artifact-attack"
for f in multisig-testnet-tools.cjs multisig-testnet-audit.cjs multisig-testnet-audit-cli.js; do docker cp "$ROOT/tests/$f" "$KCLI:$K/driver/$f"; done
KEY_PLACED=1; read_funder | docker exec -i "$KCLI" sh -c "umask 077; cat > $FKEY"   # flag first: a partial write is still cleaned up
DRIVER_SHAS=$(docker exec "$KCLI" sh -c "cd $K/driver && sha256sum multisig-testnet-tools.cjs multisig-testnet-audit.cjs multisig-testnet-audit-cli.js" | awk '{print $2" "$1}')
tool() { docker exec -e KCLI_ROOT="$WORKTREE" -e RUN_ID="$RUN" "$KCLI" node "$K/driver/multisig-testnet-tools.cjs" "$1" "$K" "${@:2}"; }
audit() { docker exec -e KCLI_ROOT="$WORKTREE" -e RUN_ID="$RUN" "$KCLI" node "$K/driver/multisig-testnet-audit.cjs" "$1" "$K" "${@:2}"; }
cli() { docker exec -e KCLI_ROOT="$WORKTREE" -e RUN_ID="$RUN" -e NETWORK=testnet -e DEPLOY_RC="${DEPLOY_RC:-100000000}" -e CALL_RC=20000000 "$KCLI" node "$K/driver/multisig-testnet-audit-cli.js" "$1" "$K" "$RPC"; }
build_artifact() { # <inputs file in K> <artifact dir in K>
  docker exec "$BUILDER" mkdir -p "$B/$2/src"; CREATED_B=1
  COPYFILE_DISABLE=1 tar -C "$ROOT/contracts/multisig-treasury" -cf - . | docker exec -i "$BUILDER" tar -C "$B/$2/src" -xf - 2>/dev/null
  docker exec "$KCLI" cat "$K/$1" | docker exec -i "$BUILDER" sh -c "cat > $B/$2/inputs.json"
  docker exec "$BUILDER" "$B/$2/src/scripts/build.sh" "$B/$2/src" "$B/$2/inputs.json" "$B/$2/out"
  docker exec "$BUILDER" tar -C "$B/$2/out" -cf - contract.wasm treasury.abi inputs.json artifact.json | docker exec -i "$KCLI" tar -C "$K/$2" -xf -
}
docker network connect bridge "$KCLI"; JOINED=1
tool precheck "$FKEY"
tool keys
build_artifact inputs.json artifact
USED=$(tool estimate-upload "$FKEY" | sed -n 's/^UPLOAD_RC //p')
# Hard budget: provisioning is fixed at 10 tKOIN (= 1e9 Mana); the limit is 2x the measured use, capped below that.
[[ "$USED" =~ ^[0-9]{1,12}$ ]] && [ "$USED" -gt 0 ] && [ "$USED" -le 475000000 ] || { echo "upload estimate $USED outside the supported range (<= 475,000,000)" >&2; exit 2; }
DEPLOY_RC=$(( USED * 2 > 50000000 ? USED * 2 : 50000000 )); [ "$DEPLOY_RC" -le 950000000 ] || { echo 'derived RC limit exceeds the provisioning' >&2; exit 2; }; export DEPLOY_RC
PROVISION=10
TREASURY=$(docker exec "$KCLI" node -e "console.log(JSON.parse(require('fs').readFileSync('$K/keys.json')).treasury.address)")
echo "upload rc used $USED -> limit $DEPLOY_RC, provisioning $PROVISION tKOIN to $TREASURY"
audit fund "$FKEY" "$TREASURY" "$PROVISION"      # funding ids are retained in audit/funding.json (persisted before the send)
cli deploy                                   # bootstrap + A13a + verify-deployment (polled to finality)
tool verify                                  # independent bootstrap check (raw code, metadata, flags, storage, nonce, allowances)
audit fund "$FKEY" "$TREASURY" 5
audit matrix "$FKEY"                         # A1-A10 on the live treasury (policy v0); stops on any non-pass verdict
cli operate1                                 # real payment with --wait 5, reconcile, A12
audit replay "$K/payment-1.approved.json"    # A5a: exact replay of the executed payment
cli operate2                                 # rotation by the old quorum, payment by the new quorum
audit attack-keys                            # A11: fresh address, same owners
build_artifact inputs-attack.json artifact-attack
audit allowance "$FKEY"                      # outsider-paid approval on the fresh address, irreversible
cli allowance                                # released CLI refuses to bootstrap it
docker exec "$KCLI" rm -f -- "$FKEY"
if docker exec "$KCLI" test ! -e "$FKEY"; then KEY_PLACED=0; else echo 'funder key copy could not be confirmed removed' >&2; exit 3; fi   # not needed from here on
audit proofs "$K/evidence-cli.json"          # canonical, irreversible, anchored, body = submitted, not reverted; treasury/recipient/funder reconciliation
audit summary
mkdir -p "$EVIDENCE.partial"
for f in evidence-cli.json proofs.json audit-summary.json independent.json treasury.json treasury-v1.json deploy.signed.json payment-1.approved.json policy-1.approved.json payment-2.approved.json; do docker exec "$KCLI" cat "$K/$f" > "$EVIDENCE.partial/$f"; done
docker exec "$KCLI" node -e "const k=JSON.parse(require('fs').readFileSync('$K/keys.json'));const a=JSON.parse(require('fs').readFileSync('$K/attack.json'));const pub=o=>o.address;console.log(JSON.stringify({owners:k.owners.map(pub),future:pub(k.future),treasury:pub(k.treasury),recipient:pub(k.recipient),attack:pub(a.attack),koin:k.koin},null,1))" > "$EVIDENCE.partial/keys-public.json"
mkdir -p "$EVIDENCE.partial/audit"; docker exec "$KCLI" tar -C "$K/audit" -cf - . | tar -C "$EVIDENCE.partial/audit" -xf -
docker exec "$KCLI" cat "$K/artifact/artifact.json" > "$EVIDENCE.partial/artifact.json"
docker exec "$KCLI" cat "$K/artifact-attack/artifact.json" > "$EVIDENCE.partial/artifact-attack.json"
# run.json and the recursive artifact index are produced by a JSON encoder (no shell interpolation); every JSON file is parsed first.
RUN_ID="$RUN" STARTED_AT="$STARTED_AT" USED="$USED" DEPLOY_RC="$DEPLOY_RC" PROVISION="$PROVISION" TREASURY="$TREASURY" KCLI_SHA="$KCLI_SHA" KCLI_VERSION="$KCLI_VERSION" DRIVER_SHAS="$DRIVER_SHAS" DIST_TREE_SHA="$DIST_TREE_SHA" RUNTIME_ID="$RUNTIME_ID" IMAGE_ID="$IMAGE_ID" ORCHESTRATOR_SHA="$(shasum -a 256 "$0" | cut -d' ' -f1)" \
  python3 -I "$ROOT/tests/multisig-audit-index.py" "$EVIDENCE.partial" complete
mv "$EVIDENCE.partial" "$EVIDENCE"; STAGED=1
echo "AUDIT EVIDENCE $EVIDENCE"
