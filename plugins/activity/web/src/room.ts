/**
 * Room UI: text chat panel, poke/headpat on the avatar, and the
 * watch-together link card the brain opens with a room_action.
 */

import type { BusMessage, ClientEvent } from "./protocol.ts";

/** Clicks in the top part of the avatar canvas count as a headpat */
export const HEAD_FRACTION = 0.3;

export interface Room {
  show(msg: BusMessage): void;
}

export function reactionFor(yFraction: number): ClientEvent {
  return yFraction < HEAD_FRACTION ? { type: "headpat" } : { type: "poke" };
}

export function mountRoom(
  root: HTMLElement,
  avatar: HTMLElement,
  send: (event: ClientEvent) => void,
  openLink: (url: string) => void,
): Room {
  const doc = root.ownerDocument;

  avatar.addEventListener("click", (e) => {
    const rect = avatar.getBoundingClientRect();
    send(reactionFor(rect.height > 0 ? (e.clientY - rect.top) / rect.height : 1));
  });

  const panel = doc.createElement("div");
  panel.className = "chat";
  const log = doc.createElement("ul");
  const form = doc.createElement("form");
  const input = doc.createElement("input");
  input.placeholder = "Say something…";
  input.maxLength = 500;
  const button = doc.createElement("button");
  button.type = "submit";
  button.textContent = "Send";
  form.append(input, button);
  panel.append(log, form);
  root.append(panel);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    const line = doc.createElement("li");
    line.textContent = `you: ${text}`;
    log.append(line);
    input.value = "";
  });

  let card: HTMLElement | null = null;
  const showWatchCard = (url: string) => {
    card?.remove();
    card = doc.createElement("div");
    card.className = "card";
    const title = doc.createElement("div");
    title.textContent = "Watch together";
    const link = doc.createElement("button");
    link.textContent = url;
    link.addEventListener("click", () => openLink(url));
    card.append(title, link);
    root.append(card);
  };

  return {
    show(msg) {
      if (msg.type === "room" && msg.action === "watch_together" && typeof msg.args.url === "string") {
        showWatchCard(msg.args.url);
      }
    },
  };
}
