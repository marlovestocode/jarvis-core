#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import trimesh

failed = False
report = []

for name in sys.argv[1:]:
    path = Path(name)
    mesh = trimesh.load(path, force="mesh", process=True)
    bounds = mesh.bounds.tolist()
    dimensions = (mesh.bounds[1] - mesh.bounds[0]).tolist()
    result = {
        "file": str(path),
        "triangles": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "volume_mm3": round(abs(float(mesh.volume)), 3),
        "bounds_mm": [round(float(v), 3) for v in dimensions],
        "z_min_mm": round(float(mesh.bounds[0][2]), 3),
        "z_max_mm": round(float(mesh.bounds[1][2]), 3),
    }
    report.append(result)
    if not result["watertight"] or not result["winding_consistent"] or result["volume_mm3"] <= 0:
        failed = True

print(json.dumps(report, indent=2))
if failed:
    raise SystemExit("One or more STL meshes failed watertightness, winding, or volume validation.")
