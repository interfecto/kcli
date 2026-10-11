#!/usr/bin/env python3
"""Run manifest + recursive artifact index for a testnet audit evidence directory (public evidence only).
usage: multisig-audit-index.py <evidence dir> complete|partial
environment: RUN_ID STARTED_AT KCLI_SHA KCLI_VERSION TREASURY [complete: USED DEPLOY_RC PROVISION DRIVER_SHAS DIST_TREE_SHA RUNTIME_ID IMAGE_ID ORCHESTRATOR_SHA]
Every JSON file is parsed (fails the run if malformed), every file is scanned for home paths and WIF fields, and
index.json lists path, bytes and SHA-256 of every file including the manifest."""
import datetime, hashlib, json, os, sys

ev, mode = sys.argv[1], sys.argv[2]
assert mode in ('complete', 'partial')
env = os.environ.get
sha = lambda f: hashlib.sha256(open(f, 'rb').read()).hexdigest()
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def walk():
    out = []
    for root, _dirs, files in os.walk(ev):
        for f in files:
            full = os.path.join(root, f)
            out.append((os.path.relpath(full, ev).replace(os.sep, '/'), full))
    return sorted(out)


manifest_name = 'run.json' if mode == 'complete' else 'run-partial.json'
manifest = {'schema': 1, 'runId': env('RUN_ID'), 'startedAt': env('STARTED_AT'), ('finishedAt' if mode == 'complete' else 'failedAt'): now, 'complete': mode == 'complete',
            'network': 'official testnet', 'chainId': 'EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==', 'koin': '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju',
            'kcli': {'version': env('KCLI_VERSION'), 'distIndexSha256': env('KCLI_SHA')}, 'treasury': env('TREASURY') or None}
if mode == 'complete':
    drivers = dict(l.split(' ', 1) for l in env('DRIVER_SHAS', '').strip().split('\n') if l.strip())
    manifest['kcli'].update({'distTreeSha256': env('DIST_TREE_SHA'), 'distIdenticalToReleaseTarball': True, 'runtime': env('RUNTIME_ID'), 'containerImage': env('IMAGE_ID')})
    manifest.update({'drivers': {'executedInContainer': drivers, 'orchestratorOnHost': {'multisig-testnet-audit.sh': env('ORCHESTRATOR_SHA')}},
                     'uploadRcUsed': env('USED'), 'deployRcLimit': env('DEPLOY_RC'), 'provisionedTkoin': int(env('PROVISION', '0')), 'operationsTkoin': 5, 'allowanceTkoin': 1})
json.dump(manifest, open(os.path.join(ev, manifest_name), 'w'), indent=1)

problems = []
for rel, full in walk():
    if rel == 'index.json':
        continue
    data = open(full, 'rb').read()
    if rel.endswith('.json') or rel.endswith('.jsonl'):
        try:
            if rel.endswith('.jsonl'):
                for line in data.splitlines():
                    if line.strip():
                        json.loads(line)
            else:
                json.loads(data)
        except ValueError as e:
            problems.append(f'malformed JSON: {rel}: {e}')
    if b'/Users/' in data or b'/home/' in data or b'"wif"' in data:
        problems.append('sanitization: ' + rel)

index = [{'path': rel, 'bytes': os.path.getsize(full), 'sha256': sha(full)} for rel, full in walk() if rel != 'index.json']
json.dump({'schema': 1, 'complete': mode == 'complete', 'files': index}, open(os.path.join(ev, 'index.json'), 'w'), indent=1)
for pr in problems:
    print('EVIDENCE PROBLEM: ' + pr, file=sys.stderr)
print(('evidence files: ' if mode == 'complete' else 'partial evidence files: ') + str(len(index)))
if problems and mode == 'complete':
    sys.exit(1)
