Use this when a task needs free models, textures, HDRIs, fonts, icons or sounds.
Covers: sources, licences, script-download commands (tested/untested), licence checklist.
Sources: front 5 report (each source's own licence page), accessed 2026-11-08.

## Rules
- Prefer CC0 (Poly Haven, ambientCG, Kenney): no attribution bookkeeping. — https://polyhaven.com/license, https://docs.ambientcg.com/license/, https://kenney.nl/support
- Resolve Poly Haven files through `api.polyhaven.com/files/<id>`; never guess resolution URLs. — https://api.polyhaven.com
- Get ambientCG zips via `https://ambientcg.com/get?file=<AssetId>_<Res>-<Fmt>.zip`; list them with `/api/v2/full_json`. — https://docs.ambientcg.com/api/
- Freesound: read `license` on every sound; CC-BY needs credit and CC-BY-NC rules out commercial use. API calls need a token. — https://freesound.org/help/faq/, https://freesound.org/docs/api/authentication.html
- OpenGameArt and Khronos glTF samples: check each asset's own licence field or LICENSE.md, because the site has no single licence. — https://opengameart.org/content/faq, https://github.com/KhronosGroup/glTF-Sample-Assets
- Ship the licence file with fonts (OFL) and icons (ISC/MIT). — https://openfontlicense.org, https://lucide.dev/license
- Record the source URL, licence and access date next to every downloaded asset (for example `ASSETS.md`).

## Sources
| Source | Asset types | Licence (own page) | Script download? | Command | Result | Tag |
|---|---|---|---|---|---|---|
| Poly Haven | HDRIs, textures, models | CC0 — https://polyhaven.com/license | Yes, public JSON API, no key | `requests.get("https://api.polyhaven.com/files/kloppenheim_06")` then `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloppenheim_06_1k.hdr` | 200, 2 KB JSON; 200, 1.49 MB .hdr | tested |
| ambientCG | PBR materials, HDRIs, models | CC0 — https://docs.ambientcg.com/license/ | Yes, API + direct zip | `https://ambientcg.com/api/v2/full_json?type=Material&limit=1&include=downloadData`; `https://ambientcg.com/get?file=Bricks059_1K-JPG.zip` | 200, 13 KB JSON; 200, 8.27 MB zip | tested |
| Kenney | models, sprites, UI kits, sounds | CC0 — https://kenney.nl/support | Partly. Asset page loads (200), but no zip link was found in its static HTML (hashed media URLs) | `requests.get("https://kenney.nl/assets/ui-pack")` | 200, 18.5 KB, 0 .zip links | tested (page); zip untested |
| Google Fonts | fonts | Mostly SIL OFL 1.1, set per family (the OFL.txt in each folder) — https://github.com/google/fonts | Yes, via raw GitHub or the CSS API | `https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt`; `https://fonts.googleapis.com/css2?family=Inter` | 200, 4.4 KB; 200, 207 B CSS | tested |
| Lucide | icons (SVG) | ISC, plus MIT for icons that came from Feather — https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE | Yes, npm `lucide-static` | `https://registry.npmjs.org/lucide-static/latest` → tarball `lucide-static-1.70.0.tgz` | 200, metadata | tested (metadata only) |
| Tabler Icons | icons (SVG) | MIT — https://raw.githubusercontent.com/tabler/tabler-icons/main/LICENSE | Yes, raw GitHub | `https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/home.svg` | 200, 511 B | tested |
| Freesound | sounds | Per sound: CC0 / CC-BY / CC-BY-NC — https://freesound.org/help/faq/ | Only with an API token (search) or OAuth2 (original files); previews work with a token | `https://freesound.org/apiv2/search/text/?query=click` (no token) | 401 "Authentication credentials were not provided." | tested (fails without a key) |
| OpenGameArt | 2D/3D, sounds, UI | Per asset (CC0, CC-BY, GPL…) — https://opengameart.org/content/faq | HTML only, no API; scraping is fragile | `requests.get("https://opengameart.org/content/cc0-resources")` | 200, 220 KB HTML | tested (page only) |
| Khronos glTF-Sample-Assets | glTF test models | Per model in its LICENSE.md (e.g. Duck is listed with CC-BY 4.0 for docs/metadata) — https://github.com/KhronosGroup/glTF-Sample-Assets | Yes, raw GitHub | `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb` | 200, 120 KB | tested |
| Sonniss GDC bundles | sound effects | Royalty-free licence on the page, not CC — https://sonniss.com/gameaudiogdc | No, huge torrent/manual downloads | `requests.get("https://sonniss.com/gameaudiogdc")` | 200 page | tested (page only) |

Snippet (tested 2026-11-08):
```python
import requests
j = requests.get("https://api.polyhaven.com/files/kloppenheim_06").json()
url = j["hdri"]["1k"]["hdr"]["url"]
open("sky_1k.hdr","wb").write(requests.get(url).content)
```

## Checklist
- [ ] Every asset has its source URL, licence and access date recorded.
- [ ] Licence read from the asset's own page or field, not the site's general claim (Freesound, OpenGameArt, Khronos).
- [ ] CC-BY assets have a credit line; there are no NC assets in commercial work.
- [ ] OFL/ISC/MIT licence text is shipped alongside fonts and icons.
- [ ] Download URLs come from the API, not guesses; check status 200 and a non-zero size.
- [ ] Commands marked untested if they were not run (Kenney zip, Freesound with a token, Lucide tarball).

## Disagreements and unknowns
- Khronos: the Duck LICENSE.md lists CC-BY 4.0 for documentation. The model itself may carry a separate (SCEA) licence. Treat it as test-only until confirmed.
- Kenney zip URLs are hashed. Get them from the rendered page or download by hand.
- Google Fonts: a few families use Apache 2.0 or UFL instead of OFL. Check the folder (`ofl/`, `apache/`, `ufl/`).
