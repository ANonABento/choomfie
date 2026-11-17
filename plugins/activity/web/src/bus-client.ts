import type { BusConnection } from "./app.ts";
import type { BusMessage } from "./protocol.ts";

/** Bus WebSocket on the same origin (Discord's proxy maps /bus to the bot) */
export function connectBus(token: string, onMessage: (msg: BusMessage) => void): BusConnection {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/bus?token=${encodeURIComponent(token)}`);
  const pending: string[] = [];
  ws.onopen = () => pending.splice(0).forEach((m) => ws.send(m));
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as BusMessage | { type: "error"; message: string };
    if (msg.type === "error") console.error(`activity bus: ${msg.message}`);
    else onMessage(msg);
  };
  ws.onclose = (e) => console.error(`activity bus closed (${e.code}) ${e.reason}`);
  return {
    send(event) {
      const raw = JSON.stringify(event);
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else pending.push(raw);
    },
  };
}
