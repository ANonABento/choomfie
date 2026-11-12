# Evals
Fixed tasks. Re-run after library/template changes. Score = PASS on first try (no human fixes).

## cad-01: M3 L-bracket
Prompt: "L-bracket, base 40x20x4, wall 40x4x16 on back edge, 2x M3 clearance holes in base, 1x M3 pilot hole through wall."
PASS when: renders rc=0, bbox 40x20x20, watertight, 1 body, sits at z=0, holes use clearance_d/pilot_d.
File: evals/cad-01.scad

## Results
| date | eval | setup | first-try | notes |
|---|---|---|---|---|
| 2026-11-11 | cad-01 | template + BOSL2 | PASS | bbox 40x20x20, watertight, 1 body. Sandbox needed apt openscad + pip trimesh. Not printed. |
