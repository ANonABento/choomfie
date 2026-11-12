include <BOSL2/std.scad>

clr            = 0.3;
hole_add       = 0.2;
chamfer_bottom = 0.4;
$fn = 64;

function pilot_d(m)     = m==2 ? 1.8 : m==3 ? 2.7 : 3.6;
function clearance_d(m) = m==2 ? 2.4 : m==3 ? 3.4 : 4.5;

/* EVAL cad-01: L-bracket. base 40x20x4, wall 40x4x16 on back edge.
   2x M3 clearance (vertical) in base, 1x M3 pilot (horizontal) through wall. */
diff()
cuboid([40,20,4], anchor=BOTTOM, chamfer=chamfer_bottom, edges=BOTTOM){
  position(BACK+TOP) cuboid([40,4,16], anchor=BACK+BOTTOM);
  tag("remove") for(x=[-12,12]) translate([x,-3,0]) cyl(d=clearance_d(3), h=20);
  tag("remove") translate([0,8,12]) xrot(90) cyl(d=pilot_d(3), h=20);
}
