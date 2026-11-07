/**
 * `/mode` for Waymond: working styles that turn its sandbox (`run_python`,
 * root, apt/pip, internet, a persistent workspace) into a coding agent, a
 * planner or a CAD bench.
 *
 * Waymond keeps no instructions of ours between messages, and a skill in its
 * workspace isn't reliably picked up, so each frame rides along on every
 * message. Each one says how to work *and* what to hand back, because the
 * deliverable (a patch, an STL) is what the Discord side turns into
 * attachments and buttons.
 *
 * Observed limits behind the wording: every run_python is a fresh container
 * (nothing installed carries over, /tmp is empty) and is killed somewhere
 * under 200 s; workspace files persist and come back as attachments when
 * linked.
 */

import type { SiteMode } from "@choomfie/webbrain";

const SANDBOX =
  "Each run_python is a fresh container killed after ~150 s: nothing installed carries over, so install what you need at the start of every run " +
  "(apt-get install -y -qq …, pip install -q …) and keep each run under 120 s, one focused step per run. Only workspace files persist.";

export const WAYMOND_MODES: SiteMode[] = [
  {
    id: "code",
    label: "Code",
    description: "Coding agent: edits a GitHub repo in its sandbox, runs the tests, hands back a patch",
    frame: `[code mode — work it through yourself before replying; never ask questions mid-task, state assumptions at the end. Plain tone.
${SANDBOX}
Every run: apt-get install -y -qq git curl unzip; curl -fsSL https://bun.sh/install | bash (or the repo's own toolchain); git clone --depth 1 <repo> /tmp/repo; install deps. Carry edits between runs as workspace patches/wip.patch (git apply at start, git diff > it at end).
Loop: read the code (grep first) → smallest change in the repo's style → run the narrowest tests, then the repo's own check scripts (package.json scripts like \`bun run type-check\` / \`bun run lint\`, or its Makefile/CI config) — required, not optional → on failure read, fix, rerun (max 6 tries). A reply without real test output is a failure.
Finish: save git diff as workspace patches/<short-name>.patch. Reply with exactly: one line saying what changed; a line \`repo: <owner>/<name>\`; the last 5 lines of test output in a code block; the patch link; assumptions if any. No commits or PRs unless asked.]`,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Planner: reads the code or researches, writes a step-by-step plan, changes nothing",
    frame: `[plan mode — investigate, then plan; change nothing (no commits, PRs, emails or posts). Plain tone, no questions mid-task.
For a repo: clone it in run_python (${SANDBOX}) and read the real code; cite files and functions. For anything else: research first (web_search), cite sources.
Write the plan to workspace plans/<short-name>.md: Goal · What exists now (with file/function refs) · Approach and why (alternatives briefly rejected) · Steps, each small and checkable · Risks / unknowns · How to verify.
Reply with: a 3–5 line summary, the decisions I need to make (if any), and the plan link.]`,
  },
  {
    id: "cad",
    label: "CAD",
    description: "3D-printable parts in OpenSCAD: STL, preview renders, size and filament check",
    frame: `[cad mode — parametric parts for FDM printing, in mm. Plain tone, no questions mid-task; state what you assumed (especially any bought hardware: screws, bearings, rails).
${SANDBOX}
Tools: apt-get install -y -qq --no-install-recommends openscad xvfb xauth; pip install -q trimesh manifold3d (or cadquery when you need STEP or fillets).
Design rules: simple is better — fewest parts and screws, features integrated into the print; lean on filament, no optional extras. Flat face on the bed at Z=0, overhangs ≤45° or bridged, walls ≥1.2 mm, 0.2–0.3 mm clearance on fits, named parameters at the top of the .scad.
Check every version: render the STL (openscad -o), preview PNGs from iso + front + top (xvfb-run -a openscad --render -o x.png --imgsize=900,700 --autocenter --viewall --camera=…), trimesh: watertight, bounding box, volume → grams of PLA at 1.24 g/cm³ (solid, upper bound). Fix anything that fails before replying.
Save to workspace cad/<name>/ (.scad, .stl, PNGs). Reply with: one line on the design, bounding box (mm), estimated grams, printability notes, links to the STL and PNGs, and the .scad.]`,
  },
  {
    id: "3d",
    label: "3D model",
    description: "Blender modelling and renders: shapes, scenes, GLB/STL export, preview images",
    frame: `[3d mode — model in Blender, headless. Plain tone, no questions mid-task; state assumptions at the end.
${SANDBOX}
Tools: apt-get install -y -qq --no-install-recommends blender (≈20 s); write a bpy script to a workspace file and run blender -b --python <script> so the next run can rebuild from it. Give objects material colours (Workbench: shading.color_type = 'MATERIAL'). Render with the Workbench or Cycles CPU engine at low samples (≤32) and ≤1000 px so a run fits in time; Eevee needs a GPU and won't work.
Export .glb (for viewing) and .stl (for printing, if it's a printable object; then also check watertight with trimesh). Keep the .blend.
Save to workspace models/<name>/. Reply with: one line on what you made, dimensions, links to the preview PNGs, .glb, .stl and .blend.]`,
  },
];

/**
 * Between tool calls Waymond sometimes writes a note to itself, and those
 * notes are glued onto the start of the answer with no space or newline:
 * "No git; download tarball.No node/bun present. …I fixed `chunkForDiscord`…".
 * In the first paragraph, a sentence end run straight into the next sentence
 * marks that seam; keep what follows the last one. Only used for mode replies,
 * where the answer starts after tool work.
 */
export function stripNarration(text: string): string {
  const nl = text.indexOf("\n");
  const head = nl === -1 ? text : text.slice(0, nl);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=[A-Z`*#])/g)) cut = m.index! + 1;
  return cut === -1 ? text : text.slice(cut).trimStart();
}
