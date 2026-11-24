/**
 * Markdown Discord can't show, rewritten into markdown it can — done on our
 * side, for every brain, rather than by asking models not to write it (a
 * rule in every prompt costs tokens on every call and is still ignored).
 *
 * Tables: Discord prints `| a | b |` rows as raw pipes. A narrow table
 * becomes an aligned code block; a wide one a bullet per row, which wraps
 * cleanly on a phone.
 */

/** Widest table kept as a code block (monospace wraps badly on a phone past this). */
const MAX_BLOCK_WIDTH = 56;

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** A cell as plain text (for a code block, where markdown would show literally). */
function plain(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)_(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** Characters a cell takes in monospace (wide CJK and emoji count double). */
function width(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return n;
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

function renderTable(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const fill = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
  const head = fill(header);
  const body = rows.map(fill);
  const plainRows = [head, ...body].map((r) => r.map(plain));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...plainRows.map((r) => width(r[i]))));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (cols - 1);
  if (total <= MAX_BLOCK_WIDTH) {
    const line = (r: string[]) => r.map((c, i) => (i === cols - 1 ? c : pad(c, widths[i]))).join("  ").trimEnd();
    const rule = widths.map((w) => "─".repeat(w)).join("  ");
    return ["```", line(plainRows[0]), rule, ...plainRows.slice(1).map(line), "```"].join("\n");
  }
  // Wide: one bullet per row, the first cell as its title, the rest labelled by their header.
  return body
    .map((r) => {
      const [first, ...rest] = r;
      const parts = rest.map((c, i) => (c ? (head[i + 1] ? `${plain(head[i + 1])}: ${c}` : c) : "")).filter(Boolean);
      const title = first ? `**${plain(first)}**` : "";
      return `- ${[title, parts.join(" · ")].filter(Boolean).join(" — ")}`;
    })
    .join("\n");
}

/** Rewrite every markdown table outside code blocks. Everything else is left as written. */
export function tablesForDiscord(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (!fenced && line.includes("|") && next !== undefined && SEPARATOR.test(next) && next.includes("-")) {
      const header = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) rows.push(cells(lines[j]));
      if (header.length >= 2 || rows.some((r) => r.length >= 2)) {
        out.push(renderTable(header, rows));
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
