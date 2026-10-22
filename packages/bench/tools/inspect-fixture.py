#!/usr/bin/env python3
"""Regenerate the reference from a caller-supplied pinned upstream checkout, offline.
Executes Inspect's scalar reducer functions unchanged; only their Score wrapper is replaced.
"""
import ast
import json
import math
from pathlib import Path
import statistics
import sys
import types

source = Path(sys.argv[1]) / 'src/inspect_ai/scorer/_reducer/reducer.py'
tree = ast.parse(source.read_text())
functions = []
for name in ['_compute_scalar_stat', 'pass_k_k']:
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    # Deferred annotations allow the external Score/typing wrapper to stay uninstalled.
    node.decorator_list = []
    functions.append(node)
module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *functions], type_ignores=[])
ns = {'math': math, 'k': 1, 'value': 1.0, '_is_reducible': math.isfinite,
      '_reduced_score': lambda value, scores: value, '_nan_score': lambda scores: float('nan')}
exec(compile(ast.fix_missing_locations(module), '<Inspect AI scalar reducers>', 'exec'), ns)
rows = []
for scores in [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [1, 0, 1, 1, 0], [1, 0], [0, 1, 0, 0, 0]]:
    for k in [1, 2, 3, 5]:
        ns['k'] = k
        wrapped = [types.SimpleNamespace(value=x) for x in scores]
        result = ns['_compute_scalar_stat'](wrapped, float, ns['pass_k_k'])
        rows.append({'scores': scores, 'k': k,
                     'mean': ns['_compute_scalar_stat'](wrapped, float, statistics.mean),
                     'passHat': result if math.isfinite(result) else None})
print(json.dumps({'source': 'UKGovernmentBEIS/inspect_ai', 'commit': '5e06ec2d8ba569c4ec867bfd48a7d66cda53c370',
                  'procedure': 'Execute upstream _compute_scalar_stat and pass_k_k AST unchanged; mean uses upstream statistics.mean; replace only Score wrapper.', 'rows': rows}, indent=2))
