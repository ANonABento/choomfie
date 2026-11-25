import type { HarnessSpec } from "@choomfie/harness";
import antigravity from "./antigravity.ts";

/** Every harness, in `/brain` order. Adding one = a spec file + a line here. */
export const HARNESSES: HarnessSpec[] = [antigravity];
