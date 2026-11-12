# Core — cad (Bambu P1S, 0.4 mm nozzle, PLA)
- Put every fit value in one variable at the top (`clr = 0.3;`) so a fit can be fixed without editing the whole model.
- Sliding/moving fit: 0.3 mm per side. Loose drop-in: 0.4. Press fit: 0.1 (test coupon first).
- Holes print undersized: model round holes +0.2 mm on diameter.
- Screws (no inserts), self-tapping into PLA. Starting values, confirm via lessons:
  | Screw | Pilot Ø (threads bite) | Clearance Ø (passes through) | Min wall around pilot |
  |---|---|---|---|
  | M2 | 1.8 | 2.4 | 1.2 |
  | M3 | 2.7 | 3.4 | 1.6 |
  | M4 | 3.6 | 4.5 | 2.0 |
  Pilot depth = engaged length + 1 mm. Print pilot holes vertical (along Z) when possible; keep them round.
- Horizontal holes (axis parallel to the bed): teardrop or flat-top so they print without support. Exception: a horizontal pilot hole stays round.
- Overhangs ≤ 45° from vertical; otherwise chamfer, re-orient, or add support.
- Walls ≥ 1.2 mm (3 lines); thinner than 0.8 won't print right.
- Orient so the main load does not pull layers apart; put the largest flat face on the bed.
- 0.4 mm chamfer on bottom edges (elephant's foot).
- Before delivering: run `cad_check.py --expect X,Y,Z --hole D` and get PASS.
