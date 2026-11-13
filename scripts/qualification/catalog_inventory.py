#!/usr/bin/env python3
"""Read-only catalog inventory. Output can contain private protocol metadata."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path

import yaml


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def inventory(root):
    root = root.resolve(strict=True)
    entries, files, identities = [], [], set()
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are not accepted in the catalog snapshot')
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        files.append({'path': rel, 'sha256': digest(path)})
        if path.name != 'skill.yaml':
            continue
        data = yaml.safe_load(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or data.get('schema') != 'eigengrid.scientific-skill/v1':
            raise ValueError(f'Invalid manifest: {rel}')
        identity = (data.get('id'), data.get('version'))
        if not all(isinstance(x, str) and x for x in identity) or identity in identities:
            raise ValueError(f'Missing or duplicate identity: {rel}')
        identities.add(identity)
        entries.append({
            'id': identity[0], 'version': identity[1], 'manifest': rel,
            'manifest_sha256': files[-1]['sha256'], 'status': data.get('status'),
            'knowledge_level': data.get('knowledge_level'),
            'declared_capability_levels': data.get('capability_levels'),
            'declared_engine_compatibility': data.get('engine_compatibility'),
            'domains': data.get('domains'),
            'renderer_implementation': 'not assessed', 'engine_on_target_node': 'not assessed',
            'license_authorization': 'not assessed', 'parser_implementation': 'not assessed',
            'site_end_to_end': 'not assessed', 'scientific_acceptance': 'not assessed',
        })
    if not entries:
        raise ValueError('No skill manifests found')
    # Hash a canonical listing of every file, not the application-specific corpus digest.
    canonical = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return {'schema': 'eigengrid.qualification-catalog-inventory/v1',
            'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'root': str(root), 'snapshot_sha256': hashlib.sha256(canonical).hexdigest(),
            'snapshot_definition': 'SHA-256 of UTF-8 canonical JSON array of relative file paths and SHA-256 digests',
            'files': files, 'entries': entries,
            'warning': 'Declarations are not proof of executability or scientific acceptance.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path, help='new private JSON file')
    args = parser.parse_args()
    report = inventory(args.root)
    # Exclusive create and private mode: never overwrite an earlier evidence record.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(report, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    print(f'Wrote {len(report["entries"])} entries to {args.output}')


if __name__ == '__main__':
    main()
