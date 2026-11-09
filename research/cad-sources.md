# CAD sources check — choomfie `plugins/waymond/library/ref/cad.md`
Accessed 2026-11-08 (PT). Sandbox: OpenSCAD 2021.01 (apt), BOSL2 (git HEAD), CadQuery (pip), cq_warehouse (git HEAD).

## Answer
The two thread snippets now run: both are **tested**. No insert hole size and no Bambu P1S number could be checked against a primary source. The maker shops (cnckitchen.store, ruthex.de) returned HTTP 429. Bambu wiki/spec URLs returned 404 or 403. McMaster's page loads but has no hole table in its HTML. So the insert table still rests on one secondary source, and the Bambu numbers (tolerance, overhang, bridging, minimum wall) don't exist in cad.md or in any source I could reach.

## Corrections
1. **cq_warehouse is not on PyPI.** `pip install cq_warehouse` fails ("No matching distribution"). Install it with `pip install git+https://github.com/gumyr/cq_warehouse.git` (needs git). Tested.
2. **`IsoThread` returns only the thread ridges, not a solid rod.** The output is valid (`isValid()=True`), but its volume is 194.5 mm³ for M10×1.5×20. You must union it with a core cylinder (≈ minor Ø) yourself. Tested.
3. **Threads section label:** change "untested" to "tested" for both snippets. BOSL2 `threaded_rod(d=10,l=20,pitch=1.5,$slop=0.15)` renders Simple: yes in 2021.01. Two `include` statements on one line work, but put each on its own line for readability. Tested.
4. **Minor edit to the insert hole-depth rule:** "Hole depth = L + 1" matches CNC Kitchen's blog ("blind hole roughly 1 mm deeper than the insert", straight not tapered, normally no chamfer at the hole edge): https://www.cnckitchen.com/blog/tipps-amp-tricks-fr-gewindeeinstze-im-3d-druck-3awey (200 OK, 2026-11-08). Add "straight bore, no edge chamfer" to cad.md.

## Confirmed
| Claim in cad.md | Source | Status |
|---|---|---|
| Blind insert hole ≈ L + 1 mm | CNC Kitchen blog (above), 2026-11-08 | confirmed (primary: maker's own blog) |
| BOSL2 `threaded_rod` + `$slop` API | https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad, 2026-11-08 | tested |
| cq_warehouse `IsoThread(major_diameter, pitch, length, external)` | https://cq-warehouse.readthedocs.io/en/latest/thread.html, 2026-11-08 | tested |
| Bambu wiki support page exists, says large overhangs need support | https://wiki.bambulab.com/en/software/bambu-studio/support (200), 2026-11-08 | confirmed (gives no angle number) |

## Unverified (with reason)
| Number(s) | Why unverified |
|---|---|
| Insert hole Ø: M2 3.2 / M2.5 4.0 / M3 4.0 / M3 5×4 4.4 / M4 5.6 (ruthex) or 5.7 (CNCK) / M5 6.4 or 6.5 | The maker pages returned HTTP 429. The only source with these numbers is the secondary supra.silviaai.dev side-by-side, plus SEO calculators (creative3dp, buildcad, loftsmith, machinistcalcs), which I rejected. |
| Insert L×Ø dimensions (all rows) | Same as above. |
| Min wall 1.3 / 1.6 / 2.1 / 2.6 | Same as above. |
| McMaster hole sizes | mcmaster.com is a JS catalogue. The HTML (200) has no tables, and the per-part CAD/PDF needs an interactive session. |
| BU kit M3 4.0 / M4 4.7 / M5 6.3 | I didn't re-fetch the PDF this pass. It's a different insert line in any case. |
| Prusa: accuracy ≈0.2 mm, moving gap ≥0.3 mm, sliding fit 0.2–0.3/side | Quoted from an earlier fetch of help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135. I didn't re-check it this pass. |
| P1S 0.4 mm tolerance / overhang angle / bridge length / min wall | Bambu publishes no such design-guide numbers at any URL I reached. wiki.bambulab.com P1 spec paths returned 404, and bambulab.com tech-specs returned 403. cad.md also has no P1S-specific numbers, so there's nothing to correct. Don't add any without a source. |
| `$slop` 0.15 example | This is a calibration placeholder by design, not a sourced value. |

## Recommendation
Before you trust the insert table, check it once by hand in a real browser (task: work_in_chrome on the cnckitchen.store and ruthex.de product pages, which list "recommended hole diameter"). Or measure your own inserts and print a hole-size coupon (e.g. 3.9/4.0/4.1 for M3).
