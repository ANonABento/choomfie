import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBrain, unregisterBrain, type BrainMessage } from "@choomfie/shared";
import { brainTools } from "../lib/tools/brain-tools.ts";
import type { AppContext } from "../lib/types.ts";

const askBrain = brainTools.find((t) => t.definition.name === "ask_brain")!;
const dataDir = mkdtempSync(join(tmpdir(), "ask-brain-"));
const ctx = { DATA_DIR: dataDir } as unknown as AppContext;
const textOf = (r: Awaited<ReturnType<typeof askBrain.handler>>) => (r.content[0] as { text: string }).text;

afterEach(() => unregisterBrain("fake"));

describe("ask_brain", () => {
  test("sends the prompt and files, saves what comes back", async () => {
    let got: BrainMessage | null = null;
    registerBrain({
      id: "fake",
      label: "Fake",
      send: async (m) => {
        got = m;
        return { text: "made two", files: [{ name: "a.png", data: new Uint8Array([1, 2]) }, { name: "../../evil.png", data: new Uint8Array([3]) }] };
      },
    });
    const ref = join(dataDir, "ref.png");
    writeFileSync(ref, "x");
    const saveTo = join(dataDir, "out");
    const r = await askBrain.handler({ brain: "fake", prompt: "draw", chat_id: "123", files: [ref], save_to: saveTo }, ctx);
    const t = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(got!.chatKey).toBe("123");
    expect(got!.filePaths).toEqual([ref]);
    expect(got!.meta.role).toBe("owner");
    expect(t).toContain("made two");
    expect(readFileSync(join(saveTo, "a.png"))).toEqual(Buffer.from([1, 2]));
    // a name with a path can't leave save_to
    expect(existsSync(join(saveTo, "evil.png"))).toBe(true);
    expect(t).toContain(join(saveTo, "evil.png"));
  });

  test("default folder is under the data dir", async () => {
    registerBrain({ id: "fake", label: "Fake", send: async () => ({ text: "ok", files: [{ name: "b.png", data: new Uint8Array([9]) }] }) });
    const t = textOf(await askBrain.handler({ brain: "fake", prompt: "go", chat_id: "1" }, ctx));
    expect(t).toContain(join(dataDir, "brain-files", "fake"));
  });

  test("background and choices are reported", async () => {
    registerBrain({ id: "fake", label: "Fake", send: async () => ({ text: "started", background: true, choices: ["A", "B"] }) });
    const t = textOf(await askBrain.handler({ brain: "fake", prompt: "go", chat_id: "1" }, ctx));
    expect(t).toContain("still working");
    expect(t).toContain("A | B");
  });

  test("errors: unknown brain, claude, missing file, relative save_to", async () => {
    registerBrain({ id: "fake", label: "Fake", send: async () => ({ text: "" }) });
    expect((await askBrain.handler({ brain: "nope", prompt: "x", chat_id: "1" }, ctx)).isError).toBe(true);
    expect((await askBrain.handler({ brain: "claude", prompt: "x", chat_id: "1" }, ctx)).isError).toBe(true);
    expect((await askBrain.handler({ brain: "fake", prompt: "x", chat_id: "1", files: ["/no/such.png"] }, ctx)).isError).toBe(true);
    expect((await askBrain.handler({ brain: "fake", prompt: "x", chat_id: "1", save_to: "rel/dir" }, ctx)).isError).toBe(true);
  });
});
