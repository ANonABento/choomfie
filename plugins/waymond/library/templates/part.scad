// part.scad: Choomfie CAD template (Bambu P1S, 0.4 nozzle, PLA). Values mirror core/cad.md.
// BOSL2 is included: for standard geometry (chamfers, rounding, teardrops, screw holes,
// attachments, threads) search the BOSL2 docs before hand-writing it. Write custom code
// only for what is unique to this part.
include <BOSL2/std.scad>

/* [Fits] tune here only */
clr            = 0.3;  // sliding fit per side (loose 0.4, press 0.1)
hole_add       = 0.2;  // round holes print undersized
chamfer_bottom = 0.4;  // elephant's foot
$fn = 64;

/* [Screw table] self-tapping into PLA, starting values (untested) */
function pilot_d(m)     = m==2 ? 1.8 : m==3 ? 2.7 : 3.6;   // threads bite
function clearance_d(m) = m==2 ? 2.4 : m==3 ? 3.4 : 4.5;   // screw passes through

/* [Part] example: 40x20x5 plate, two M3 clearance holes */
L = 40; W = 20; H = 5; screw = 3; hole_inset = 6;

// Vertical round hole (along Z). Horizontal non-screw hole: BOSL2 teardrop(d=, l=, ang=45).
module hole(d, h) cyl(d=d+hole_add, h=h+0.02, anchor=BOTTOM);

diff()
  cuboid([L, W, H], anchor=BOTTOM, chamfer=chamfer_bottom, edges=BOTTOM)
    for (x = [-1, 1])
      tag("remove") position(BOTTOM)
        translate([x*(L/2-hole_inset), 0, -0.01]) hole(clearance_d(screw), H);
