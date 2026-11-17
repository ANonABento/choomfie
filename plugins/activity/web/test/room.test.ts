import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mountRoom } from "../src/room.ts";
import type { ClientEvent } from "../src/protocol.ts";

function setup() {
  const window = new Window();
  const { document } = window;
  const root = document.createElement("div");
  const avatar = document.createElement("canvas");
  root.append(avatar);
  avatar.getBoundingClientRect = () => ({ top: 0, height: 100 }) as unknown as ReturnType<typeof avatar.getBoundingClientRect>;
  const sent: ClientEvent[] = [];
  mountRoom(root as unknown as HTMLElement, avatar as unknown as HTMLElement, (e) => void sent.push(e), () => {});
  const click = (clientY: number) => avatar.dispatchEvent(new window.MouseEvent("click", { clientY }));
  return { root, sent, click };
}

describe("room", () => {
  test("clicking the body emits poke, the head emits headpat", () => {
    const { sent, click } = setup();
    click(80);
    click(10);
    expect(sent).toEqual([{ type: "poke" }, { type: "headpat" }]);
  });

  test("chat panel sends trimmed text", () => {
    const { root, sent } = setup();
    const input = root.querySelector("input")!;
    input.value = "  hi choom ";
    root.querySelector("form")!.requestSubmit();
    expect(sent).toEqual([{ type: "chat", text: "hi choom" }]);
    expect(root.querySelector("li")!.textContent).toBe("you: hi choom");
  });
});
