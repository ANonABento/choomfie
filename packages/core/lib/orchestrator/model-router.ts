/**
 * ModelRouter — routes a request to the chat or coding model based on intent.
 *
 * The chat model handles short conversational replies (low latency).
 * The coding model handles tool-call / pipeline / long-reasoning work.
 */

import type { ModelRegistry } from "./model-registry.ts";

export type Route = "chat" | "coding";

export interface RouteDecision {
  route: Route;
  model: string;
  reason: string;
}

const CODING_SIGNAL_RE =
  /\b(write|implement|refactor|fix|debug|patch|review|grep|search|tsc|lint|tests?|jest|vitest|migrate|sql|schema|merge\s+conflict|stack trace|traceback|exception|nullpointer|undefined is not|cannot read prop|typescript|python|rust|golang)\b/i;

const CODING_BLOCK_RE = /```/;
const FILE_PATH_RE = /\/[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|sql|md|yaml|yml|json|toml)\b/;

const LONG_REASONING_THRESHOLD = 280;

export interface RoutingHints {
  /** Caller-declared intent — overrides heuristics. */
  forceRoute?: Route;
  /** Caller is the bento-ya pipeline / background task system. */
  background?: boolean;
  /** True when the message arrived from a Discord chat in conversation mode. */
  conversational?: boolean;
}

export class ModelRouter {
  constructor(private registry: ModelRegistry) {}

  decide(text: string, hints: RoutingHints = {}): RouteDecision {
    const sel = this.registry.getSelection();

    if (hints.forceRoute) {
      return {
        route: hints.forceRoute,
        model: hints.forceRoute === "coding" ? sel.coding : sel.chat,
        reason: `forced=${hints.forceRoute}`,
      };
    }

    if (hints.background) {
      return { route: "coding", model: sel.coding, reason: "background-task" };
    }

    if (CODING_BLOCK_RE.test(text)) {
      return { route: "coding", model: sel.coding, reason: "code-fence" };
    }

    if (FILE_PATH_RE.test(text)) {
      return { route: "coding", model: sel.coding, reason: "file-path" };
    }

    if (text.length >= LONG_REASONING_THRESHOLD && CODING_SIGNAL_RE.test(text)) {
      return { route: "coding", model: sel.coding, reason: "long+coding-keyword" };
    }

    if (CODING_SIGNAL_RE.test(text) && text.length >= 80) {
      return { route: "coding", model: sel.coding, reason: "coding-keyword" };
    }

    return { route: "chat", model: sel.chat, reason: "default-chat" };
  }
}
