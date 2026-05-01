import type { Exercise } from "../../../core/lesson-types.ts";
import { pick, pickN } from "../../../core/random.ts";

export function recognition(char: string, reading: string, pool: string[]): Exercise {
  const distractors = pickN(pool.filter((r) => r !== reading), 3);
  return {
    type: "recognition",
    prompt: `What sound does **${char}** make?`,
    answer: reading,
    distractors,
  };
}

export function production(char: string, reading: string, kanaType: "hiragana" | "katakana"): Exercise {
  return {
    type: "production",
    prompt: `Type the ${kanaType} for **"${reading}"**`,
    answer: char,
    accept: [reading],
  };
}

export function renderChartGrid(
  grid: (string | null)[][],
  rowLabels?: string[],
  colLabels?: string[],
): string {
  const cellWidth = 3;
  const lines: string[] = [];

  if (colLabels) {
    const header = (rowLabels ? "   " : "") + colLabels.map((l) => l.padStart(cellWidth)).join(" ");
    lines.push(header);
  }

  for (let r = 0; r < grid.length; r++) {
    let line = rowLabels ? `${(rowLabels[r] ?? "").padEnd(3)}` : "";
    for (let c = 0; c < grid[r].length; c++) {
      const cell = grid[r][c];
      if (cell === null) {
        line += " __".padStart(cellWidth + 1);
      } else {
        line += ` ${cell}`.padStart(cellWidth + 1);
      }
    }
    lines.push(line);
  }

  return "```\n" + lines.join("\n") + "\n```";
}

export function chartReview(knownChars: [string, string][]): Exercise {
  const gridSize = Math.min(knownChars.length, 10);
  const selected = knownChars.slice(0, gridSize);

  const blankIdx = selected.indexOf(pick(selected));

  const cols = 5;
  const rows = Math.ceil(gridSize / cols);
  const grid: (string | null)[][] = [];
  const colLabels = ["a", "i", "u", "e", "o"];
  const rowLabels: string[] = [];
  let blankChar = "";
  let blankReading = "";
  let blankRow = 0;
  let blankCol = 0;

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const row: (string | null)[] = [];
    const firstReading = selected[idx]?.[1] ?? "";
    rowLabels.push(firstReading.length > 1 ? firstReading[0] + "-" : "∅-");

    for (let c = 0; c < cols && idx < gridSize; c++, idx++) {
      if (idx === blankIdx) {
        row.push(null);
        blankChar = selected[idx][0];
        blankReading = selected[idx][1];
        blankRow = r;
        blankCol = c;
      } else {
        row.push(selected[idx][0]);
      }
    }
    grid.push(row);
  }

  const distractorPool = pickN(
    selected.map(([char]) => char).filter((c) => c !== blankChar),
    3
  );

  const gridText = renderChartGrid(grid, rowLabels, colLabels);

  return {
    type: "chart",
    prompt: `Which character goes in the blank? (reading: **${blankReading}**)\n${gridText}`,
    answer: blankChar,
    distractors: distractorPool,
    chart: {
      grid,
      blanks: [{ row: blankRow, col: blankCol, answer: blankChar, reading: blankReading }],
      rowLabels,
      colLabels,
    },
  };
}
