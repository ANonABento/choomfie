# Core — cad (FDM, Bambu P1S, 0.4 mm nozzle)
- Give moving parts ≥ 0.3 mm clearance per side; printer accuracy is ~0.2 mm, so press/slip fits need a test coupon. (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- Keep unsupported overhangs ≤ 45° from vertical (45–60° possible with tuning on a 0.4 nozzle). (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- Make walls a multiple of extrusion width: 0.45 mm single, 0.9 mm double for a 0.4 nozzle; design ≥ 0.9 mm (≥ 1.2 mm for structure). (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- Use teardrop or flat-top horizontal holes so they print without support. (45° rule applied) (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- Keep bridges short and straight; long bridges need support. (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- For heat-set inserts: straight hole (no taper), depth = insert length + ~1 mm for blind holes, wall around hole ≥ datasheet min. (https://www.cnckitchen.com/blog/tipps-amp-tricks-fr-gewindeeinstze-im-3d-druck-3awey); hole Ø/min wall unverified (https://supra.silviaai.dev/reference/heat-set-insert-hole-sizes, https://www.bu.edu/epic/files/2026/08/Heat-Set-Insert-Guide-pg2.pdf)
- Orient so loads run along layers, never pulling layers apart (Z is the weak axis). (https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135) — magnitude untested here
- Thread ≥ M6 can be printed; smaller → heat-set insert or self-tap. (https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad) untested judgment
- Export at fine tessellation and run the trimesh checks below before delivery. (https://trimesh.org/trimesh.base.html)
