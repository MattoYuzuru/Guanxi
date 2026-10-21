#!/usr/bin/env python3
"""Audit pinned external-process dependencies against ADR-0016 before installation.
Only public PyPI package metadata is requested. Never prints environment/config values.
"""
import concurrent.futures
import json
from pathlib import Path
import sys
import hashlib
import re
import tomllib
import urllib.request

ALLOWED = {'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
           'Zlib', 'CC0-1.0', 'Unlicense', 'MPL-2.0', 'BlueOak-1.0.0', 'Python-2.0'}
# Exact package/version exceptions require upstream evidence in python/LICENSES.json.
root = Path(__file__).resolve().parents[1]
reviewed = json.loads((root / 'python/LICENSES.json').read_text()) if (root / 'python/LICENSES.json').exists() else {}

def audit(p):
    name, version = p['name'], p['version']
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response:
        data = response.read()
        info = json.loads(data)['info']
    digest = hashlib.sha256(data).hexdigest()
    license_id = info.get('license_expression') or info.get('license') or ''
    aliases = {'Apache 2.0': 'Apache-2.0', 'Apache 2': 'Apache-2.0', 'Apache License, Version 2.0': 'Apache-2.0', 'Apache License 2.0': 'Apache-2.0', 'ISC License': 'ISC'}
    license_id = aliases.get(license_id, license_id)
    if license_id.lstrip().startswith(('MIT License', 'The MIT License (MIT)')):
        license_id = 'MIT'
    external_only = {'PSF-2.0', 'CNRI-Python'}
    def acceptable(expr):
        parts = re.split(r'\s+(?:AND|OR)\s+', expr)
        return all(x in ALLOWED | external_only for x in parts)
    if not acceptable(license_id):
        item = reviewed.get(f'{name}=={version}')
        if item and acceptable(item['license']) and item.get('source') and item.get('sha256') == digest:
            license_id = item['license']
    return {'package': f'{name}=={version}', 'license': license_id if len(license_id) < 80 else 'non-SPDX', 'allowed': acceptable(license_id), 'boundary': 'external-process-only', 'metadata_sha256': digest}

packages = [p for p in tomllib.loads((root / 'python/uv.lock').read_text())['package'] if 'registry' in p['source']]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    rows = sorted(pool.map(audit, packages), key=lambda r: r['package'])
print(json.dumps(rows, indent=2))
sys.exit(int(any(not r['allowed'] for r in rows)))
