#!/usr/bin/env python3
"""Waymond cad mode: build, render and check an OpenSCAD part in one step.

    python cad_check.py part.scad [--expect X,Y,Z] [--hole D ...] [--out DIR]

- installs openscad + trimesh on first use (each sandbox run starts fresh)
- part.stl with a full CGAL render, and iso / front / top PNGs (--render, not
  the preview renderer, which shows z-fighting artifacts)
- checks: watertight, one body, flat face on the bed at Z=0, size against
  --expect (any order, ±0.3 mm), holes against --hole (round holes found by
  slicing), overhang area steeper than 45°, PLA grams
- prints PASS / WARN / FAIL lines; exit 1 on FAIL

Fetched by URL from the Choomfie repo, so every chat checks parts the same way.
"""

import argparse
import os
import shutil
import subprocess
import sys


def sh(cmd, timeout=120):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)


def ensure_tools():
    if not shutil.which("openscad"):
        sh("apt-get update -qq && apt-get install -y -qq --no-install-recommends openscad xvfb xauth >/dev/null 2>&1", 150)
    try:
        import trimesh  # noqa: F401
        import shapely  # noqa: F401
    except ImportError:
        sh(f"{sys.executable} -m pip install -q trimesh shapely manifold3d rtree scipy networkx", 150)


VIEWS = {
    # name: camera translate x,y,z, rotate x,y,z, distance (0 = auto with --viewall)
    "iso": "0,0,0,55,0,25,0",
    "front": "0,0,0,90,0,0,0",
    "top": "0,0,0,0,0,0,0",
}


def holes(mesh):
    """Diameters of round holes, found by slicing along each axis."""
    import numpy as np

    found = []
    for axis in range(3):
        n = np.zeros(3)
        n[axis] = 1
        lo, hi = mesh.bounds[0][axis], mesh.bounds[1][axis]
        for f in (0.2, 0.5, 0.8):
            o = np.zeros(3)
            o[axis] = lo + (hi - lo) * f
            s = mesh.section(plane_origin=o, plane_normal=n)
            if s is None:
                continue
            p2, _ = s.to_2D()
            for poly in p2.polygons_full:
                for ring in poly.interiors:
                    xy = np.array(ring.coords)
                    r = np.sqrt(((xy - xy.mean(0)) ** 2).sum(1))
                    if r.mean() > 0 and r.std() / r.mean() < 0.05:
                        found.append(round(2 * r.mean(), 2))
    return sorted(set(found))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scad")
    ap.add_argument("--expect", help="overall size X,Y,Z in mm (any order)")
    ap.add_argument("--hole", type=float, action="append", default=[], help="a round hole diameter that must exist")
    ap.add_argument("--out", help="output dir (default: next to the .scad)")
    a = ap.parse_args()

    ensure_tools()
    import numpy as np
    import trimesh

    out = a.out or os.path.dirname(os.path.abspath(a.scad))
    os.makedirs(out, exist_ok=True)
    name = os.path.splitext(os.path.basename(a.scad))[0]
    stl = os.path.join(out, f"{name}.stl")
    r = sh(f"openscad -o '{stl}' '{a.scad}'")
    if r.returncode != 0 or not os.path.exists(stl):
        print("FAIL  openscad:", (r.stderr or r.stdout)[-800:])
        sys.exit(1)
    for view, cam in VIEWS.items():
        sh(
            f"xvfb-run -a openscad --render -o '{os.path.join(out, f'{name}_{view}.png')}' --imgsize=900,700 "
            f"--camera={cam} --viewall --autocenter --colorscheme=Tomorrow '{a.scad}'"
        )

    m = trimesh.load(stl, force="mesh")
    fail = False

    def line(ok, msg, warn=False):
        nonlocal fail
        tag = "PASS" if ok else ("WARN" if warn else "FAIL")
        fail |= not ok and not warn
        print(f"{tag}  {msg}")

    ext = [round(float(x), 2) for x in m.extents]
    line(m.is_watertight, "watertight" if m.is_watertight else "NOT watertight (non-manifold geometry)")
    bodies = len(m.split(only_watertight=False))
    line(bodies == 1, f"{bodies} body" + ("" if bodies == 1 else "ies — floating parts?"))
    z0 = m.bounds[0][2]
    down = (m.face_normals[:, 2] < -0.99) & (np.abs(m.triangles_center[:, 2] - z0) < 0.01)
    bed = float(m.area_faces[down].sum())
    line(abs(z0) < 0.01 and bed > 20, f"on the bed: lowest Z {z0:.2f}, contact area {bed:.0f} mm²")
    if a.expect:
        want = sorted(float(x) for x in a.expect.split(","))
        ok = all(abs(x - y) <= 0.3 for x, y in zip(sorted(ext), want))
        line(ok, f"size {ext[0]} x {ext[1]} x {ext[2]} mm, expected {a.expect}")
    else:
        print(f"INFO  size {ext[0]} x {ext[1]} x {ext[2]} mm")
    found = holes(m)
    for d in a.hole:
        near = [h for h in found if abs(h - d) <= 0.25]
        line(bool(near), f"hole Ø{d}: " + (f"found Ø{near[0]}" if near else f"not found (round holes: {found or 'none'})"))
    if not a.hole and found:
        print(f"INFO  round holes: {found}")
    steep = (m.face_normals[:, 2] < -0.71) & ~down
    over = float(m.area_faces[steep].sum())
    line(over < 50, f"overhang steeper than 45°: {over:.0f} mm²" + ("" if over < 50 else " — needs supports or a chamfer"), warn=True)
    v = abs(m.volume) / 1000
    print(f"INFO  {v:.2f} cm³ → at most {v * 1.24:.1f} g PLA (solid; a slicer's figure will be lower)")
    print(f"INFO  files: {stl} and {name}_iso/front/top.png in {out}")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
