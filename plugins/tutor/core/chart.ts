import type { ChartExerciseData } from "./lesson-types.ts";

export interface ChartRenderState {
  currentBlankIndex?: number;
  filledAnswers?: Array<string | null>;
}

function cellText(
  row: number,
  col: number,
  cell: string | null,
  blanks: ChartExerciseData["blanks"],
  state: ChartRenderState
): string {
  if (cell !== null) return cell;

  const blankIndex = blanks.findIndex((blank) => blank.row === row && blank.col === col);
  if (blankIndex === -1) return "__";

  const filled = state.filledAnswers?.[blankIndex];
  if (filled) return filled;
  return blankIndex === state.currentBlankIndex ? "??" : "__";
}

export function renderChartGrid(
  grid: (string | null)[][],
  rowLabels?: string[],
  colLabels?: string[],
  blanks: ChartExerciseData["blanks"] = [],
  state: ChartRenderState = {}
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
      line += ` ${cellText(r, c, grid[r][c], blanks, state)}`.padStart(cellWidth + 1);
    }
    lines.push(line);
  }

  return "```\n" + lines.join("\n") + "\n```";
}

export function renderChartPrompt(
  exercise: ChartExerciseData,
  state: ChartRenderState = {}
): string {
  const currentBlankIndex = state.currentBlankIndex ?? 0;
  const blank = exercise.blanks[currentBlankIndex];
  const reading = blank?.reading ? ` (reading: **${blank.reading}**)` : "";
  const grid = renderChartGrid(
    exercise.grid,
    exercise.rowLabels,
    exercise.colLabels,
    exercise.blanks,
    { ...state, currentBlankIndex }
  );

  return `Fill blank ${currentBlankIndex + 1}/${exercise.blanks.length}${reading}\n${grid}`;
}
