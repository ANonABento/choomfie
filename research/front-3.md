# Front 3 — CAD for FDM (Bambu P1S, 0.4 mm nozzle)

Accessed 2026-11-08. Sandbox: CadQuery (pip, latest), trimesh (pip), OpenSCAD 2021.01 (apt). `tested` = run in that sandbox.

Sources key:
- [PRUSA] https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135 (fetched; quotes checked)
- [HSI] https://supra.silviaai.dev/reference/heat-set-insert-hole-sizes — side-by-side of ruthex + CNC Kitchen datasheets (secondary; maker pages are JS shops that didn't return tables). Makers: https://www.ruthex.de/en , https://cnckitchen.store
- [BU] https://www.bu.edu/epic/files/2026/08/Heat-Set-Insert-Guide-pg2.pdf (university lab guide for a Bambu workflow)
- [CQ] https://cadquery.readthedocs.io/en/latest/
- [SCAD] https://en.wikibooks.org/wiki/OpenSCAD_User_Manual
- [BOSL2] https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad
- [CQW] https://cq-warehouse.readthedocs.io/en/latest/thread.html
- [TM] https://trimesh.org/trimesh.base.html
- [BAMBU] https://wiki.bambulab.com/en/software/bambu-studio/support (Bambu tolerance/spec pages returned 404 on 2026-11-08)

## Core rules
- Give moving parts ≥ 0.3 mm clearance per side; printer accuracy is ~0.2 mm, so press/slip fits need a test coupon. [PRUSA]
- Keep unsupported overhangs ≤ 45° from vertical (45–60° possible with tuning on a 0.4 nozzle). [PRUSA]
- Make walls a multiple of extrusion width: 0.45 mm single, 0.9 mm double for a 0.4 nozzle; design ≥ 0.9 mm (≥ 1.2 mm for structure). [PRUSA]
- Use teardrop or flat-top horizontal holes so they print without support. [PRUSA] (45° rule applied)
- Keep bridges short and straight; long bridges need support. [PRUSA]
- For heat-set inserts: straight hole (no taper), depth = insert length + ~1 mm for blind holes, wall around hole ≥ datasheet min. [HSI][BU]
- Orient so loads run along layers, never pulling layers apart (Z is the weak axis). [PRUSA] — magnitude untested here
- Thread ≥ M6 can be printed; smaller → heat-set insert or self-tap. [BOSL2] untested judgment
- Export at fine tessellation and run the trimesh checks below before delivery. [TM]

## Reference

### Heat-set inserts (mm) [HSI]
| Insert | ruthex L×Ø | ruthex hole | CNC Kitchen L×Ø | CNC K hole | min wall ruthex/CNCK |
|---|---|---|---|---|---|
| M2 | 4.0×3.6 | 3.2 | 3.0×3.6 | 3.2 | 1.3 |
| M2.5 | 5.7×4.6 | 4.0 | 4.0×4.6 | 4.0 | 1.6 |
| M3 | 5.7×4.6 | 4.0 | 5.7×4.6 | 4.0 | 1.6 |
| M3 short | 4.0×4.6 | 4.0 | 3.0×4.6 | 4.0 | 1.6 |
| M3 Voron 5×4 | 4.0×5.0 | 4.4 | 4.0×5.0 | 4.4 | 1.3 / 1.6 |
| M4 | 8.1×6.3 | 5.6 | 8.1×6.3 | 5.7 | 2.1 |
| M5 | — | 6.4 | — | 6.5 | 2.6 |
Boss OD = insert Ø + 2×min wall. Hole depth = L + 1 (blind). BU's kit (different insert line) lists M3 hole 4.0, M4 4.7, M5 6.3 — check the actual insert. [BU]

### Clearances [PRUSA]
- Accuracy ≈ 0.2 mm; moving parts ≥ 0.3 mm gap. Start sliding fit at 0.2–0.3/side, then print a coupon.
- BOSL2 users: set `$slop` once (e.g. 0.15) after printing its calibration part. [BOSL2]

### CadQuery — insert boss + chamfered base (tested)
```python
# tested: CadQuery + trimesh, watertight=True, 1 body
import cadquery as cq
boss = (cq.Workplane("XY").circle(4.0/2 + 2.0).extrude(8)   # M3 insert hole 4.0, wall 2.0 ≥ 1.6
        .faces(">Z").workplane().hole(4.0, 6.7)              # depth 5.7 + 1
        .edges("<Z").chamfer(0.4))                           # bed chamfer vs elephant foot
cq.exporters.export(boss, "boss.stl", tolerance=0.01, angularTolerance=0.1)
```
Note: a fine `tolerance` in export avoids faceted holes that shrink effective Ø. [CQ]

### OpenSCAD — clearance fit + teardrop hole (tested, OpenSCAD 2021.01, renders Simple: yes)
```openscad
// tested
$fn=64; clr=0.2;
difference(){cube([12,12,8]); translate([6,6,-1]) cylinder(d=5+2*clr,h=10);}
translate([20,0,0]) cylinder(d=5,h=10);              // peg
module teardrop(d,l){rotate([90,0,0]) linear_extrude(l,center=true)
  hull(){circle(d=d); rotate(45) square(d/2);}}       // 45° roof, no support
translate([40,0,0]) difference(){cube([12,10,12]); translate([6,5,6]) teardrop(3.4,12);}
```
Always set `$fn` (default facet count makes small holes polygons undersized). [SCAD]

### Threads (untested)
```openscad
// untested: needs BOSL2 installed
include <BOSL2/std.scad> include <BOSL2/threading.scad>
threaded_rod(d=10, l=20, pitch=1.5, $slop=0.15);
```
```python
# untested: needs cq_warehouse
from cq_warehouse.thread import IsoThread
t = IsoThread(major_diameter=10, pitch=1.5, length=20, external=True)
```
[BOSL2][CQW]

### Mesh checks with trimesh (tested)
```python
# tested: box 10mm + floating 2mm cube -> 2 bodies; 0.5mm plate flagged thin
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
Needs `rtree`/`scipy` for split and fast rays. Ray thickness is approximate: near chamfers it reads lower than true wall (boss gave 1.3 for a 2.0 wall), so treat hits as warnings, not failures. [TM]

## Checklist
- [ ] Moving gaps ≥ 0.3 mm/side; fits have a coupon or `$slop`/clr variable.
- [ ] No overhang > 45° without support; horizontal holes teardrop/flat-top.
- [ ] Walls ≥ 0.9 mm (≥ 1.2 structural); insert walls ≥ table min.
- [ ] Insert holes from table, depth L+1, straight.
- [ ] Load path along layers; flat face on bed; 0.4 mm bed chamfer.
- [ ] `$fn` set / fine export tolerance.
- [ ] trimesh: watertight, winding consistent, 1 body (or intended count), zmin=0, thin-face scan reviewed.
