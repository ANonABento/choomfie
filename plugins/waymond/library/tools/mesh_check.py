"""Check an STL before delivery: watertight/manifold, floating bodies, thin walls.

Usage: python tools/mesh_check.py part.stl [--min-wall 0.8]
Exits 0 when clean, 1 with one line per problem. Needs trimesh, scipy, rtree.
Thin-wall depth is a ray estimate; it can read low near chamfers.
"""
import argparse
import sys

import numpy as np
import trimesh


def thin_faces(mesh, min_wall):
    """Count faces whose inward ray hits the opposite wall closer than min_wall."""
    p, n = mesh.triangles_center, mesh.face_normals
    loc, ri, _ = mesh.ray.intersects_location(p - n * 1e-4, -n, multiple_hits=False)
    d = np.full(len(p), np.inf)
    d[ri] = np.linalg.norm(loc - p[ri], axis=1)
    return int((d < min_wall).sum()), float(d.min()) if len(d) else float("inf")


def check(mesh, min_wall=0.8):
    errs = []
    if not mesh.is_watertight:
        errs.append("not watertight (open edges)")
    if not mesh.is_winding_consistent:
        errs.append("not manifold (inconsistent winding)")
    bodies = mesh.split(only_watertight=False)
    if len(bodies) > 1:
        errs.append(f"{len(bodies)} separate bodies (floating parts)")
    if mesh.is_watertight:
        n, dmin = thin_faces(mesh, min_wall)
        if n:
            errs.append(f"{n} faces thinner than {min_wall} mm (min {dmin:.2f} mm)")
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("stl")
    ap.add_argument("--min-wall", type=float, default=0.8, help="mm (default 0.8)")
    a = ap.parse_args(argv)
    errs = check(trimesh.load(a.stl, force="mesh"), a.min_wall)
    for e in errs:
        print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
