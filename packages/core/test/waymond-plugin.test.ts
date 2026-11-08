import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseTaskList } from "@choomfie/shared";
import {
  CONVERSATION_PATH_RE,
  conversationIdFromSend,
  hasWaitingCard,
  answerState,
  lateMessages,
  openOffers,
  parseMessages,
  parseTurn,
  replyFor,
  absoluteLinks,
  parseWorkspaceFile,
  workspaceFileUrl,
  workspaceLinks,
  appActionDetail,
  appActionUrl,
  parseAppAction,
} from "../../../plugins/waymond/api.ts";
import { withFiles } from "../../../plugins/waymond/adapter.ts";
import { continueAfterToolCap, planContext, stripNarration, TOOLS_REF, toolUrl, WAYMOND_MODES } from "../../../plugins/waymond/modes.ts";
import type { Page } from "@choomfie/webbrain";
import { framePrompt, originalName, toApproval } from "../../../plugins/waymond/index.ts";

// Shapes as observed from app.ambition.inc on 2026-11-04.
const turn = (over: Record<string, unknown> = {}) => ({
  active: false,
  unanswered: false,
  job_id: "j",
  source_user_message_id: "u2",
  progress: {
    tools: [
      { tool: "search", type: "t", label: "Searching the web", status: "running" },
      { tool: "read", type: "t", label: "Reading", status: "done" },
    ],
    intent: "Looking into it",
    actions: [],
    content: "",
  },
  phase: "answer",
  progress_at: "2026-11-04 20:00:00",
  ...over,
});

describe("waymond api parsing", () => {
  test("parseTurn reads state and running tools only", () => {
    const t = parseTurn(turn({ active: true }));
    expect(t).toMatchObject({ active: true, sourceUserMessageId: "u2", intent: "Looking into it" });
    expect(t.running).toEqual(["Searching the web"]);
    expect(parseTurn(null)).toEqual({ active: false, running: [] } as never);
  });

  test("done only once our new message has an answer and Waymond is idle", () => {
    const before = parseMessages([
      { id: "u1", role: "user", content: "old" },
      { id: "a1", role: "assistant", content: "old answer" },
    ]);
    const base = new Set(before.map((m) => m.id));
    // Just sent: our message not visible yet.
    expect(answerState(before, base, false, false).done).toBe(false);
    const sent = [...before, ...parseMessages([{ id: "u2", role: "user", content: "new" }])];
    // Idle before the job started, no answer yet: not done.
    expect(answerState(sent, base, false, false).done).toBe(false);
    // Working.
    expect(answerState(sent, base, true, true).done).toBe(false);
    const answered = [...sent, ...parseMessages([{ id: "a2", role: "assistant", content: "OK" }])];
    // Fast answer we never saw as active (the observed case).
    expect(answerState(answered, base, false, false)).toMatchObject({ done: true, reply: "OK" });
    // Finished with tool actions only.
    expect(answerState(sent, base, false, true)).toMatchObject({ done: true, reply: "" });
  });

  test("idle turn after completion carries no source id (observed)", () => {
    expect(parseTurn({ active: false, unanswered: false })).toEqual({ active: false, running: [] } as never);
  });

  test("replyFor collects the answer to one message, not the next one", () => {
    const msgs = parseMessages([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "answer one" },
      { id: "u2", role: "user", content: "second" },
      { id: "a2", role: "assistant", content: "part A" },
      { id: "a3", role: "assistant", content: "part B" },
      { id: "u3", role: "user", content: "third" },
    ]);
    expect(replyFor(msgs, "u2")).toBe("part A\n\npart B");
    expect(replyFor(msgs, "u1")).toBe("answer one");
    // Unknown id → trailing run after the last user message (none here).
    expect(replyFor(msgs, "missing")).toBe("");
    expect(replyFor(msgs.slice(0, 5), "missing")).toBe("part A\n\npart B");
  });

  test("waiting cards are detected per conversation whatever the value shape", () => {
    expect(hasWaitingCard({ total: 0, conversations: {} }, "c")).toBe(false);
    expect(hasWaitingCard({ total: 1, conversations: { c: 1 } }, "c")).toBe(true);
    expect(hasWaitingCard({ total: 1, conversations: { c: [{ id: "x" }] } }, "c")).toBe(true);
    expect(hasWaitingCard({ total: 1, conversations: { other: 1 } }, "c")).toBe(false);
  });

  test("conversation id is read from the chat URL", () => {
    const id = "f96c82f8-2298-485d-8e76-3317bba629f2";
    expect(CONVERSATION_PATH_RE.exec(`https://app.ambition.inc/chat/${id}`)?.[1]).toBe(id);
    expect(CONVERSATION_PATH_RE.exec("https://app.ambition.inc/chat?new=1")).toBeNull();
    expect(conversationIdFromSend(JSON.stringify({ messages: [], conversation_id: id }))).toBe(id);
    expect(conversationIdFromSend("not json")).toBeNull();
    expect(conversationIdFromSend(JSON.stringify({ conversation_id: "../x" }))).toBeNull();
  });
});

describe("quick replies and background jobs (observed 2026-11-04)", () => {
  const observed = parseMessages([
    { id: "u1", role: "user", content: "pizza or tacos?", tool_calls: null },
    {
      id: "a1",
      role: "assistant",
      content: "Pizza or tacos?",
      tool_calls: [{ tool: "offer_replies", status: "completed", data: { options: ["I’ll go with pizza", "I’m choosing tacos"] } }],
    },
    { id: "u2", role: "user", content: "research the Raspberry Pi", tool_calls: null },
    {
      id: "a2",
      role: "assistant",
      content: "I've started researching…",
      tool_calls: [{ tool: "start_task", status: "completed", data: { research_job_id: "j" } }],
    },
  ]);

  test("offer_replies options are surfaced as choices", () => {
    const st = answerState(observed.slice(0, 2), new Set(), false, false);
    expect(st.options).toEqual(["I’ll go with pizza", "I’m choosing tacos"]);
    expect(st.background).toBe(false);
  });

  test("start_task marks the answer as continuing in the background", () => {
    const st = answerState(observed, new Set(["u1", "a1"]), false, false);
    expect(st).toMatchObject({ done: true, background: true, lastMessageId: "a2" });
  });

  test("late results: everything Waymond posted after the watermark that wasn't delivered", () => {
    const later = [...observed, ...parseMessages([
      { id: "u3", role: "user", content: "thanks" },
      { id: "a4", role: "assistant", content: "np" },
      // Background result landing after the newer exchange.
      { id: "a5", role: "assistant", content: "Here is the report." },
    ])];
    expect(lateMessages(later, "a2", new Set(["a4"])).map((m) => m.id)).toEqual(["a5"]);
    expect(lateMessages(later, "a2", new Set(["a4", "a5"]))).toEqual([]);
    expect(lateMessages(later, "unknown")).toEqual([]); // never re-post the window
  });
});

describe("framePrompt", () => {
  test("owner messages pass through; others are labelled", () => {
    expect(framePrompt("hi", { role: "owner" })).toBe("hi");
    expect(framePrompt("hi", { role: "user", user: "alex" })).toBe("[Discord message from alex]\nhi");
  });

  test("inbox prefixes are stripped from attachment names", () => {
    expect(originalName("/x/inbox/1793824118401_ab12cd_photo.png")).toBe("photo.png");
    expect(originalName("/x/inbox/plain.txt")).toBe("plain.txt");
  });
});

describe("app actions (propose_app_action observed 2026-11-08)", () => {
  const msg = {
    id: "m1",
    role: "assistant",
    content: "The fix is in a card waiting for you to approve.",
    tool_calls: [
      {
        tool: "propose_app_action",
        status: "completed",
        data: { tool_name: "Create or update file contents", tier: "ask", app: "github", action_id: "af5f", summary: "Fix the workflow" },
      },
      { tool: "offer_replies", status: "completed", data: { options: ["I approved it"] } },
    ],
  };

  test("a proposed app action becomes an approval, approved through app-actions", () => {
    const [o] = parseMessages([msg])[0].offers;
    expect(o).toMatchObject({ id: "app:af5f", title: "Fix the workflow", subtitle: "github · Create or update file contents", primary: "Approve" });
    expect(openOffers(parseMessages([msg]))).toHaveLength(1);
    expect(appActionUrl("af5f", "approve")).toEndWith("/api/waymond/app-actions/af5f/approve");
  });

  test("its preview lists the arguments, cutting a whole file short", () => {
    const a = parseAppAction({
      status: "pending",
      tier: "ask_twice",
      toolkit: "github",
      tool_name: "Create or update file contents",
      summary: "s",
      arguments: { repo: "BentoSite", content: "x\n".repeat(500) },
    })!;
    const d = appActionDetail(a);
    expect(d).toStartWith("⚠️ Can't be undone.");
    expect(d).toContain("**repo:** BentoSite");
    expect(d).toContain("(1000 chars)");
    expect(parseAppAction({ nope: 1 })).toBeNull();
  });
});

describe("approval cards (offer_post observed 2026-11-04)", () => {
  const card = (status: string) => ({
    id: "a9",
    role: "assistant",
    content: "I've drafted a one-line post for RedTeam.",
    tool_calls: [
      {
        tool: "offer_post",
        status: "completed",
        data: {
          offer: {
            kind: "post",
            title: "RedTeam",
            detail: "Bridge test, please ignore.",
            status,
            primary: "Send",
            offer_id: "offer-1",
            subtitle: "New message",
            image_url: null,
            secondary: "Not now",
          },
        },
      },
      { tool: "offer_replies", status: "completed", data: { options: [] } },
    ],
  });

  test("open offers become approvals with Ambition's own button labels", () => {
    const msgs = parseMessages([{ id: "u", role: "user", content: "go" }, card("open")]);
    const st = answerState(msgs, new Set(), false, false);
    expect(st.offers).toHaveLength(1);
    expect(toApproval(st.offers[0])).toEqual({
      id: "offer-1",
      title: "RedTeam · New message",
      detail: "Bridge test, please ignore.",
      approveLabel: "Send",
      declineLabel: "Not now",
    });
  });

  test("declined or sent offers are not offered again", () => {
    expect(openOffers(parseMessages([card("declined")]))).toEqual([]);
    expect(openOffers(parseMessages([card("sent")]))).toEqual([]);
  });
});

describe("settling (race observed 2026-11-04)", () => {
  test("an answer isn't settled until its tool calls are attached", () => {
    const base = new Set<string>();
    const early = parseMessages([
      { id: "u", role: "user", content: "cats or dogs?", tool_calls: null },
      { id: "a", role: "assistant", content: "Cats or dogs?", tool_calls: null },
    ]);
    expect(answerState(early, base, false, false)).toMatchObject({ done: true, settled: false, options: [] });
    const late = parseMessages([
      { id: "u", role: "user", content: "cats or dogs?", tool_calls: null },
      {
        id: "a",
        role: "assistant",
        content: "Cats or dogs?",
        tool_calls: [{ tool: "offer_replies", status: "completed", data: { options: ["Cats", "Dogs"] } }],
      },
    ]);
    expect(answerState(late, base, false, false)).toMatchObject({ done: true, settled: true, options: ["Cats", "Dogs"] });
  });
});

describe("workspace files (link shape observed 2026-11-06)", () => {
  const OWNER = "00000000-0000-0000-0000-000000000001";
  const link = (path: string) => `/chat?workspace=${encodeURIComponent(path)}&owner=${OWNER}`;
  const text =
    `**[Card v12, preview](${link("cards/v12/card.png")})** · **[Print PDF](${link("cards/v12/card.pdf")})**\n` +
    `Again: [preview](${link("cards/v12/card.png")}), elsewhere: [site](https://example.com/a)`;

  test("finds each workspace file once, in order; leaves other links alone", () => {
    expect(workspaceLinks(text)).toEqual([
      { path: "cards/v12/card.png", owner: OWNER },
      { path: "cards/v12/card.pdf", owner: OWNER },
    ]);
    expect(workspaceFileUrl({ path: "a b/c.png", owner: null })).toBe(
      "https://api-production.ambition.inc/api/waymond/workspace/file?path=a%20b%2Fc.png"
    );
  });

  test("app-relative links become absolute; absolute ones are untouched", () => {
    const out = absoluteLinks(text);
    expect(out).toContain(`(https://app.ambition.inc${link("cards/v12/card.png")})`);
    expect(out).toContain("(https://example.com/a)");
    expect(out).not.toMatch(/\]\(\//);
  });

  test("workspace/file: bytes only from the app's own download route, else inline text", () => {
    expect(parseWorkspaceFile({ download_url: "/api/waymond/workspace/download?t=1", mime_type: "image/png" })).toEqual({
      downloadUrl: "https://api-production.ambition.inc/api/waymond/workspace/download?t=1",
    });
    expect(parseWorkspaceFile({ download_url: "https://evil.example/x" })).toBeNull();
    expect(parseWorkspaceFile({ content: "print(1)", mime_type: "text/x-python" })).toEqual({ content: "print(1)" });
    expect(parseWorkspaceFile(null)).toBeNull();
  });

  test("withFiles: fetches what it can, attaches under the file's name, never fails the answer", async () => {
    const files: Record<string, unknown> = {
      "cards/v12/card.png": { download_url: "/api/waymond/workspace/download?f=png" },
      "cards/v12/card.pdf": { download_url: "/api/waymond/workspace/download?f=pdf" },
      "cards/make.py": { content: "print(1)" },
    };
    // pageFetch passes [url, init]; pageFetchBytes passes [url, maxBytes].
    const page = {
      evaluate: async (_fn: unknown, [url, arg]: [string, unknown]) => {
        if (typeof arg === "number") return url.endsWith("f=png") ? Buffer.from([9, 9]).toString("base64") : null;
        const path = new URL(url).searchParams.get("path")!;
        return path in files ? { status: 200, json: files[path] } : { status: 404, errorText: "nope" };
      },
    } as unknown as Page;
    const out = await withFiles(page, `${text}\n[script](${link("cards/make.py")}) [gone](${link("missing.png")})`);
    expect(out.files.map((f) => [f.name, [...f.data]])).toEqual([
      ["card.png", [9, 9]],
      ["make.py", [...new TextEncoder().encode("print(1)")]],
    ]);
    expect(out.text).toContain("(https://app.ambition.inc/chat?workspace=");
  });
});

describe("modes", () => {
  test("ids are /mode-safe and unique; every frame says what to hand back", () => {
    const ids = WAYMOND_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of WAYMOND_MODES) {
      expect(m.id).toMatch(/^[a-z0-9]+$/);
      expect(m.frame).toMatch(/Reply with|End every reply|task list/);
      expect(m.frame.length).toBeLessThan(2500); // rides on every message
    }
    expect(WAYMOND_MODES.find((m) => m.id === "code")!.frame).toContain("repo: <owner>/<name>");
  });

  test("a turn Ambition cut off at its tool limit is continued (observed 2026-11-08)", () => {
    const cut = "Patches not applied by setup; apply manually.Read the code.\n\n_(Stopping after several tool calls - please re-ask if you want to continue.)_";
    expect(continueAfterToolCap(cut)).toContain("continue");
    expect(continueAfterToolCap("Added contact mode. All tests pass.")).toBeNull();
  });

  test("stripNarration drops notes glued onto the answer, and leaves normal text alone", () => {
    expect(stripNarration("No git; download tarball.No node/bun present. Let me look.I fixed `x`.\n\nMore."))
      .toBe("I fixed `x`.\n\nMore.");
    expect(stripNarration("Nested quotes; retry.```\n 22 pass\n```")).toBe("```\n 22 pass\n```");
    expect(stripNarration("Checked the sources.**Stall current:** about 360 mA")).toBe("**Stall current:** about 360 mA");
    expect(stripNarration("Short answer: **~360 mA.** TowerPro doesn't say.")).toBe("Short answer: **~360 mA.** TowerPro doesn't say.");
    const normal = "I fixed it. Tests pass.\nSee README.md for details.";
    expect(stripNarration(normal)).toBe(normal);
  });
});

describe("sandbox tools", () => {
  const tools = ["swe.sh", "cad_check.py"];

  test("frames fetch tools that exist, pinned to TOOLS_REF", () => {
    const frames = WAYMOND_MODES.map((m) => m.frame).join("\n");
    for (const f of tools) {
      expect(existsSync(join(import.meta.dir, "../../../plugins/waymond/tools", f))).toBe(true);
      expect(frames).toContain(toolUrl(f));
    }
    expect(TOOLS_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  test("TOOLS_REF has the same tools as this checkout (bump it when tools/ changes)", () => {
    for (const f of tools) {
      const path = `plugins/waymond/tools/${f}`;
      const pinned = Bun.spawnSync(["git", "show", `${TOOLS_REF}:${path}`], { cwd: join(import.meta.dir, "../../..") });
      if (pinned.exitCode !== 0) continue; // shallow clone without that commit: nothing to compare
      expect(pinned.stdout.toString()).toBe(readFileSync(join(import.meta.dir, "../../..", path), "utf8"));
    }
  });
});

describe("plan mode", () => {
  test("its example task line parses, and every mode it offers exists", () => {
    const plan = WAYMOND_MODES.find((m) => m.id === "plan")!;
    expect(plan.tasks).toBe(true);
    const ids = WAYMOND_MODES.map((m) => m.id);
    const example = plan.frame.split("\n").find((l) => /^1\. \[/.test(l))!;
    expect(parseTaskList(`Tasks\n${example}`, ids)).toEqual([
      expect.objectContaining({ n: 1, mode: "cad", title: "Motor mount" }),
    ]);
    for (const named of plan.frame.match(/\b(code|debug|cad|3d|plan) \(/g) ?? []) expect(ids).toContain(named.split(" ")[0]);
  });

  test("planContext points tasks at the plan file in the workspace", () => {
    const answer = "Plan: [plan.md](https://app.ambition.inc/chat?workspace=plans%2Farm%2Fplan.md&owner=u1)\nTasks\n1. [cad] x";
    expect(planContext(answer)).toContain("plans/arm/plan.md");
    expect(planContext("[stl](https://app.ambition.inc/chat?workspace=cad%2Fa.stl&owner=u1)")).toBeUndefined();
  });
});
