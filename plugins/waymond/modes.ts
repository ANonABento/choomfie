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

/**
 * The commit Waymond's sandbox fetches tools/ from (raw.githubusercontent.com:
 * the repo is public). Pinned, so a chat always runs scripts that match these
 * frames; bump it when tools/ changes.
 */
export const TOOLS_REF = "96b7944e9f5443db591551f7ebf56f8b8ae60e65";
export const toolUrl = (file: string) =>
  `https://raw.githubusercontent.com/ANonABento/choomfie/${TOOLS_REF}/plugins/waymond/tools/${file}`;

/** First lines of every run_python: fetch a tool, and a shell helper that prints the tail of the output. */
const fetchTool = (file: string, then = "") => `\`\`\`python
import subprocess, urllib.request
urllib.request.urlretrieve("${toolUrl(file)}", "/tmp/${file}")
def sh(c, t=140):
    r = subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t); print((r.stdout + r.stderr)[-4000:]); return r.returncode${then ? `\n${then}` : ""}
\`\`\``;

const SANDBOX =
  "Each run_python is a fresh container killed after ~150 s: nothing installed carries over, so install what you need at the start of every run " +
  "(apt-get install -y -qq …, pip install -q …) and keep each run under 120 s, one focused step per run. Only workspace files persist.";

/*
 * code and cad were measured against a small benchmark of real tasks (hidden
 * tests for patches, measured STLs for parts). Both versions got the answers
 * right; the tool versions were the only ones that ran the full test suite,
 * type-check and lint every time, and that showed their checks in the reply.
 */
export const WAYMOND_MODES: SiteMode[] = [
  {
    id: "code",
    label: "Code",
    description: "Coding agent: edits a GitHub repo in its sandbox, runs the tests, hands back a patch",
    frame: `[code mode — work it through yourself in run_python before replying; no questions mid-task, state assumptions at the end. Plain tone.
Each run_python is a fresh container killed after ~150 s; nothing installed persists. Start EVERY run with:
${fetchTool("swe.sh", 'sh("bash /tmp/swe.sh setup OWNER/REPO")  # add a wip.patch path as 3rd arg to restore earlier edits')}
setup clones to /tmp/repo, installs deps and lists the repo's own checks. Prefer doing setup + edit + check in one run; if you need more runs, save \`bash /tmp/swe.sh diff /tmp/wip.patch\` to your workspace and pass it to setup next time.
Loop: grep/read the code → smallest change in the repo's style, plus a test → \`bash /tmp/swe.sh check\` (tests + type-check + lint). Every line must say PASS (a PASS noting failures that also happen without your change is fine — leave those alone); on FAIL read it, fix, rerun (max 6). A reply without a full-PASS check is a failure.
Finish: \`bash /tmp/swe.sh diff /tmp/out/<short-name>.patch\`, save it to workspace patches/<short-name>.patch. Reply with exactly: one line on what changed; a line \`repo: <owner>/<name>\`; the check output in a code block; the patch link; assumptions. No commits or PRs unless asked.]`,
  },
  {
    id: "debug",
    label: "Debug",
    description: "Bug hunter: reproduces it with a failing test, finds the root cause, then fixes it",
    frame: `[debug mode — find the cause before fixing anything. Work it through yourself in run_python; no questions mid-task. Plain tone.
Each run_python is a fresh container killed after ~150 s; nothing installed persists. Start EVERY run with:
${fetchTool("swe.sh", 'sh("bash /tmp/swe.sh setup OWNER/REPO")  # add a wip.patch path as 3rd arg to restore earlier edits')}
1. Reproduce: write the smallest failing test (or script) that shows the bug, run it, show it failing. Can't reproduce? Stop and say what you tried and what would help (logs, versions, exact steps).
2. Cause: follow the code path, add temporary prints if needed, and state the root cause in one sentence with file and function.
3. Fix the cause, not the symptom; remove the temporary prints. The failing test now passes and \`bash /tmp/swe.sh check\` is all PASS (a PASS noting failures that also happen without your change is fine).
Finish: \`bash /tmp/swe.sh diff /tmp/out/<short-name>.patch\`, save it to workspace patches/<short-name>.patch. Reply with exactly: a line "Cause: …"; a line "Fix: …"; a line \`repo: <owner>/<name>\`; the check output in a code block; the patch link.]`,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Planning partner: talks it through, writes requirements + design, splits it into tasks you can run",
    tasks: true,
    frame: `[plan mode — you're the planning partner of an engineer (software, robots, 3D-printed parts on a Bambu P1S, electronics). Plain tone. Change nothing: no commits, PRs, emails or posts.
Talk first. While the goal, constraints or what "done" means are unclear, ask at most 3 short questions per reply and offer likely answers as quick replies. Don't ask what you can find out: read the code (run_python: urllib.request.urlretrieve("${toolUrl("swe.sh")}", "/tmp/swe.sh"), then bash /tmp/swe.sh setup OWNER/REPO) or research it (web_search, cite sources). Stop asking once you could write a test for every requirement, or when the user says go.
Then write workspace plans/<short-name>/plan.md: Requirements (numbered, each testable) · Design (approach and why, alternatives rejected; cite files/functions for repos) · Tasks · Risks and unknowns.
Tasks: each small enough for one agent in one sitting, and standalone — it goes to a fresh chat that sees only its own line and the plan file. Give each the mode that does it: code (change a GitHub repo, with tests), debug (find and fix a bug), cad (OpenSCAD printable part), 3d (Blender model), plan (a sub-plan). Name the repo for code/debug. End each with "Done when:" and a check that mode can run (firmware: native unit tests — device builds can't run in the sandbox, so say they're checked on the user's machine). Order by dependency.
End every reply that has a plan with the plan link, then a line that says only "Tasks", then one line per task, exactly like:
1. [cad] Motor mount — 40 x 30 x 5 mm plate for a NEMA 17, four M3 holes on 31 mm centres. Done when: cad_check passes with --expect 40,30,5 --hole 3.4
2. [code] Step driver — in ANonABento/robot: … Done when: …
When you change the plan, repeat the whole task list.]`,
  },
  {
    id: "cad",
    label: "CAD",
    description: "3D-printable parts in OpenSCAD: STL, preview renders, size and filament check",
    frame: `[cad mode — FDM parts for the user's Bambu P1S, 0.4 mm nozzle, PLA, in mm. Plain tone; no questions mid-task; state assumptions (especially bought hardware) at the end.
Each run_python is a fresh container killed after ~150 s. Start every run with:
${fetchTool("cad_check.py")}
Design: simple is better — fewest parts and screws, features integrated; lean on filament. Named parameters at the top of the .scad. A flat face on the bed at Z=0, overhangs ≤45° (chamfer instead), walls ≥1.2 mm.
P1S fits: holes print ~0.2 mm small, so model them +0.2 (M3 clearance 3.4); sliding fit 0.2 mm per side; snug push fit over a shaft or tube 0.1–0.15 mm per side; snap fits 0.3.
Check every version: sh("python /tmp/cad_check.py /tmp/part.scad --expect X,Y,Z --hole D") — expect = the overall size the request implies, one --hole per functional round hole. It builds the STL with iso/front/top PNG renders and prints PASS/WARN/FAIL. Fix every FAIL, then look at the PNGs and confirm the shape is what was asked.
Save to workspace cad/<name>/ (.scad, .stl, PNGs). Reply with: one line on the design; the check output in a code block; printability notes; links to the STL, PNGs and .scad.]`,
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

/**
 * Each plan task runs in a fresh chat, but it shares Waymond's workspace, so
 * it can read the plan the planning chat wrote there. The link in the answer
 * (`…/chat?workspace=plans%2Fx%2Fplan.md&owner=…`) names the file.
 */
export function planContext(answer: string): string | undefined {
  for (const m of answer.matchAll(/[?&]workspace=([^&)\s]+)/g)) {
    let path: string;
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      continue;
    }
    if (/\.md$/i.test(path) && /plan/i.test(path)) {
      const dir = path.replace(/\/[^/]*$/, "");
      return (
        `The full plan is in your workspace at ${path} — fs_read it first, but do only your task.\n` +
        `If your task changes a repo: earlier tasks' patches are in ${dir}/patches/ — pass that folder to swe.sh setup after the repo so you build on them, ` +
        `and also save your patch there as <your task number>-<short-name>.patch.`
      );
    }
  }
  return undefined;
}
