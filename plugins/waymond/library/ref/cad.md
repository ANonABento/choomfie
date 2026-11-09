Use this when modelling a part for FDM printing (inserts, clearances, threads, mesh checks).
Covers: heat-set insert sizes, clearances, CadQuery/OpenSCAD/trimesh snippets.
Sources: front 3 report (Prusa, ruthex/CNC Kitchen, CadQuery, OpenSCAD, BOSL2), accessed 2026-11-08.

Accessed 2026-11-08. Sandbox: CadQuery (pip, latest), trimesh (pip), OpenSCAD 2021.01 (apt). `tested` = run in that sandbox.

Status of each number: see `unverified` notes below. Maker pages (ruthex.de, cnckitchen.store) returned HTTP 429 and Bambu spec pages 404/403 on 2026-11-08, so insert sizes rest on a secondary source. No P1S-specific numbers are given; don't add any without a source.

## Heat-set inserts (mm) — unverified: secondary source (https://supra.silviaai.dev/reference/heat-set-insert-hole-sizes), maker datasheets unreachable; measure your inserts or print a hole coupon
| Insert | ruthex L×Ø | ruthex hole | CNC Kitchen L×Ø | CNC K hole | min wall ruthex/CNCK |
|---|---|---|---|---|---|
| M2 | 4.0×3.6 | 3.2 | 3.0×3.6 | 3.2 | 1.3 |
| M2.5 | 5.7×4.6 | 4.0 | 4.0×4.6 | 4.0 | 1.6 |
| M3 | 5.7×4.6 | 4.0 | 5.7×4.6 | 4.0 | 1.6 |
| M3 short | 4.0×4.6 | 4.0 | 3.0×4.6 | 4.0 | 1.6 |
| M3 Voron 5×4 | 4.0×5.0 | 4.4 | 4.0×5.0 | 4.4 | 1.3 / 1.6 |
| M4 | 8.1×6.3 | 5.6 | 8.1×6.3 | 5.7 | 2.1 |
| M5 | — | 6.4 | — | 6.5 | 2.6 |
Boss OD = insert Ø + 2×min wall. Hole depth = L + 1 (blind), straight bore, no edge chamfer (confirmed (https://www.cnckitchen.com/blog/tipps-amp-tricks-fr-gewindeeinstze-im-3d-druck-3awey)). BU's kit (different insert line) lists M3 hole 4.0, M4 4.7, M5 6.3 — check the actual insert. (https://www.bu.edu/epic/files/2026/08/Heat-Set-Insert-Guide-pg2.pdf) (unverified)

## Clearances (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135) (unverified: not re-checked 2026-11-08)
- Accuracy ≈ 0.2 mm; moving parts ≥ 0.3 mm gap. Start sliding fit at 0.2–0.3/side, then print a coupon.
- BOSL2 users: set `$slop` once (e.g. 0.15, a placeholder, not a sourced value) after printing its calibration part. (https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad)

## CadQuery — insert boss + chamfered base (tested)
```python
## tested: CadQuery + trimesh, watertight=True, 1 body
import cadquery as cq
boss = (cq.Workplane("XY").circle(4.0/2 + 2.0).extrude(8)   # M3 insert hole 4.0, wall 2.0 ≥ 1.6
        .faces(">Z").workplane().hole(4.0, 6.7)              # depth 5.7 + 1
        .edges("<Z").chamfer(0.4))                           # bed chamfer vs elephant foot
cq.exporters.export(boss, "boss.stl", tolerance=0.01, angularTolerance=0.1)
```
Note: a fine `tolerance` in export avoids faceted holes that shrink effective Ø. (https://cadquery.readthedocs.io/en/latest/)

## OpenSCAD — clearance fit + teardrop hole (tested, OpenSCAD 2021.01, renders Simple: yes)
```openscad
// tested
$fn=64; clr=0.2;
difference(){cube([12,12,8]); translate([6,6,-1]) cylinder(d=5+2*clr,h=10);}
translate([20,0,0]) cylinder(d=5,h=10);              // peg
module teardrop(d,l){rotate([90,0,0]) linear_extrude(l,center=true)
  hull(){circle(d=d); rotate(45) square(d/2);}}       // 45° roof, no support
translate([40,0,0]) difference(){cube([12,10,12]); translate([6,5,6]) teardrop(3.4,12);}
```
Always set `$fn` (default facet count makes small holes polygons undersized). (https://en.wikibooks.org/wiki/OpenSCAD_User_Manual)

## Threads (tested)
```openscad
// tested: OpenSCAD 2021.01 + BOSL2, renders Simple: yes
include <BOSL2/std.scad>
include <BOSL2/threading.scad>
threaded_rod(d=10, l=20, pitch=1.5, $slop=0.15);
```
```python
## tested: pip install git+https://github.com/gumyr/cq_warehouse.git (not on PyPI)
from cq_warehouse.thread import IsoThread
t = IsoThread(major_diameter=10, pitch=1.5, length=20, external=True)
# t is only the thread ridges (194.5 mm³ here): union it with a core cylinder ≈ minor Ø
```
(https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad, https://cq-warehouse.readthedocs.io/en/latest/thread.html)

## Mesh checks with trimesh (tested)
```python
## tested: box 10mm + floating 2mm cube -> 2 bodies; 0.5mm plate flagged thin
import trimesh, numpy as np
m = trimesh.load("part.stl")
assert m.is_watertight and m.is_winding_consistent
bodies = m.split(only_watertight=False)
print("bodies", len(bodies), "zmin", [b.bounds[0][2] for b in bodies])  # >1 or zmin>0 → floating
def thin_faces(mesh, minw=0.9):
    p, n = mesh.triangles_center, mesh.face_normals
    loc, ri, _ = mesh.ray.intersects_location(p - n*1e-4, -n, multiple_hits=False)
    d = np.full(len(p), np.inf); d[ri] = np.linalg.norm(loc - p[ri], axis=1)
    return int((d < minw).sum()), float(d.min())
print(thin_faces(m))
```
Needs `rtree`/`scipy` for split and fast rays. Ray thickness is approximate: near chamfers it reads lower than true wall (boss gave 1.3 for a 2.0 wall), so treat hits as warnings, not failures. (https://trimesh.org/trimesh.base.html) Or run `python tools/mesh_check.py part.stl`.
