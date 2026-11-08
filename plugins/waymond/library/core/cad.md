# Core — cad (FDM, Bambu P1S, 0.4 mm nozzle)
- Give moving parts ≥ 0.3 mm clearance per side; printer accuracy is ~0.2 mm, so press/slip fits need a test coupon. [PRUSA]
- Keep unsupported overhangs ≤ 45° from vertical (45–60° possible with tuning on a 0.4 nozzle). [PRUSA]
- Make walls a multiple of extrusion width: 0.45 mm single, 0.9 mm double for a 0.4 nozzle; design ≥ 0.9 mm (≥ 1.2 mm for structure). [PRUSA]
- Use teardrop or flat-top horizontal holes so they print without support. [PRUSA] (45° rule applied)
- Keep bridges short and straight; long bridges need support. [PRUSA]
- For heat-set inserts: straight hole (no taper), depth = insert length + ~1 mm for blind holes, wall around hole ≥ datasheet min. [HSI][BU]
- Orient so loads run along layers, never pulling layers apart (Z is the weak axis). [PRUSA] — magnitude untested here
- Thread ≥ M6 can be printed; smaller → heat-set insert or self-tap. [BOSL2] untested judgment
- Export at fine tessellation and run the trimesh checks below before delivery. [TM]
