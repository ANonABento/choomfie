import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REMOTE_TOOLS,
  handleRemoteMcpRequest,
  parseRemoteMcpConfig,
} from "../lib/remote-mcp.ts";
import { READ_ONLY, type IpcToolDef } from "../lib/ipc-types.ts";

const TOKEN = "t".repeat(43);
const tool = (name: string): IpcToolDef => ({
  name,
  description: name,
  inputSchema: { type: "object" as const, properties: {} },
});

function setup() {
  const calls: string[] = [];
  const cfg = parseRemoteMcpConfig({ enabled: true });
  const deps = {
    name: "choomfie",
    version: "test",
    listTools: () => [tool("restart"), tool("reply"), { ...tool("list_memories"), annotations: READ_ONLY }, tool("choomfie_status")],
    callTool: async (name: string) => {
      calls.push(name);
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
  };
  const rpc = (body: unknown, auth: string | null = `Bearer ${TOKEN}`, init?: RequestInit) =>
    handleRemoteMcpRequest(
      new Request("http://127.0.0.1:4142/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(auth ? { authorization: auth } : {}),
        },
        body: JSON.stringify(body),
        ...init,
      }),
      cfg,
      TOKEN,
      deps
    );
  return { calls, rpc };
}

const msg = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

describe("remote MCP endpoint", () => {
  test("rejects missing and wrong tokens", async () => {
    const { rpc, calls } = setup();
    expect((await rpc(msg(1, "tools/list"), null)).status).toBe(401);
    expect((await rpc(msg(1, "tools/list"), "Bearer nope")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("lists only allowlisted tools", async () => {
    const { rpc } = setup();
    const res = await rpc(msg(1, "tools/list"));
    expect(res.status).toBe(200);
    const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(["choomfie_status", "list_memories"]);
  });

  test("passes each tool's hints on (a client asks less for a read-only tool)", async () => {
    const { rpc } = setup();
    const tools = (await (await rpc(msg(1, "tools/list"))).json()).result.tools as { name: string; annotations?: object }[];
    expect(tools.find((t) => t.name === "list_memories")?.annotations).toEqual(READ_ONLY);
    expect(tools.find((t) => t.name === "choomfie_status")?.annotations).toBeUndefined();
  });

  test("refuses non-allowlisted tools without calling them", async () => {
    const { rpc, calls } = setup();
    for (const name of ["restart", "reply"]) {
      const body = await (await rpc(msg(2, "tools/call", { name, arguments: {} }))).json();
      expect(body.result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("forwards allowlisted tool calls", async () => {
    const { rpc, calls } = setup();
    const body = await (await rpc(msg(3, "tools/call", { name: "list_memories", arguments: {} }))).json();
    expect(body.result.content[0].text).toBe("ran list_memories");
    expect(calls).toEqual(["list_memories"]);
  });

  test("defaults to the read-only set and refuses non-loopback binds", () => {
    expect(parseRemoteMcpConfig(undefined)).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 4142,
      tools: [...DEFAULT_REMOTE_TOOLS],
    });
    expect(() => parseRemoteMcpConfig({ host: "0.0.0.0" })).toThrow(/loopback/);
  });
});
