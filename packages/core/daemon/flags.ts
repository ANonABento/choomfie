const ARGS = new Set(process.argv.slice(2));

export const FLAG_VERBOSE = ARGS.has("--verbose");
export const FLAG_STOP = ARGS.has("--stop");
export const FLAG_STATUS = ARGS.has("--status");
