import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always replaced, even if your shell exports one: tests that need a specific
// dir set their own after this runs.
process.env.CHOOMFIE_DATA_DIR = mkdtempSync(join(tmpdir(), "choomfie-test-"));
