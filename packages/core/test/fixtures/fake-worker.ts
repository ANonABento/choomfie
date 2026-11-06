/**
 * A stand-in for worker.ts in WorkerHost tests: announces one tool, echoes
 * tool calls, exits on shutdown. FAKE_WORKER_CRASH=1 exits with an error
 * right after announcing itself.
 */
const send = (m: unknown) => process.send?.(m);

process.on("message", (msg: { type: string; id?: string; name?: string; args?: unknown }) => {
  if (msg.type === "tool_call") {
    send({ type: "tool_result", id: msg.id, result: { content: [{ type: "text", text: `${msg.name}:${JSON.stringify(msg.args)}:${process.pid}` }] } });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});

send({ type: "ready", tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }], instructions: "be nice" });
if (process.env.FAKE_WORKER_CRASH === "1") setTimeout(() => process.exit(3), 50);
