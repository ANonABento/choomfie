/**
 * `pipeline` (run / status / stop): run a configured local tool (lib/pipelines)
 * for a chat. One path for every brain: Claude in a daemon session and Waymond
 * over the remote endpoint call the same tool, get the same queue, and their
 * results are posted to the chat the same way. A thread put on a pipeline with
 * `/pipeline` tells its brain so (lib/pipelines/thread-mode.ts).
 *
 * Owner only, checked in code (`callerIsOwner`).
 */

import { join } from "node:path";
import { callerIsOwner } from "../caller.ts";
import { buildArgv, PipelineError } from "../pipelines/args.ts";
import { jobLine } from "../pipelines/announce.ts";
import { pipelineRunner } from "../pipelines/index.ts";
import type { Job } from "../pipelines/runner.ts";
import { pruneByAge, resolveThreadFiles, type FileSpec } from "../pipelines/thread-files.ts";
import type { AppContext, ToolDef } from "../types.ts";
import { err, text } from "../types.ts";

/** A command that ends within this answers inline; a longer one becomes a background job. */
export const INLINE_MS = 20_000;
const MAX_RESULT_CHARS = 6000;
const OWNER_ONLY = "the pipeline tool is owner only, and the latest message in this chat isn't from the owner.";

function details(job: Job, runner: ReturnType<typeof pipelineRunner>): string {
  const lines = [jobLine(job), `job: ${job.id}`];
  if (job.result) {
    const json = JSON.stringify(job.result, null, 1);
    lines.push("result:", json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}…` : json);
  }
  if (job.state === "failed" || (job.state === "done" && !job.result)) {
    const tail = runner.logTail(job, 1500).trim();
    if (tail) lines.push("log (end):", tail);
  }
  return lines.join("\n");
}

function pipelineFor(ctx: AppContext, name: unknown) {
  const all = ctx.config.getPipelines();
  const p = all.get(String(name ?? ""));
  if (!p) throw new PipelineError(`no pipeline "${String(name ?? "")}" (configured: ${[...all.keys()].join(", ") || "none"})`);
  return p;
}

const ACTIONS = ["run", "status", "stop"] as const;

async function run(args: Record<string, unknown>, ctx: AppContext, chatId: string) {
  const p = pipelineFor(ctx, args.pipeline);
  const runner = pipelineRunner(ctx);
  const id = runner.newId(p.name);
  let filesDir: string | undefined;
  if (args.files !== undefined) {
    const base = join(ctx.DATA_DIR, "pipeline-files");
    pruneByAge(base);
    filesDir = join(base, id);
    resolveThreadFiles(ctx.DATA_DIR, chatId, args.files as FileSpec, filesDir);
  }
  const argv = buildArgv(p, args.args, filesDir);
  const job = runner.start(p, argv, (args.args as string[]).slice(), chatId, id);
  if (await runner.wait(job, INLINE_MS)) return text(details(job, runner));
  const ahead = runner.list().filter((j) => j.pipeline === p.name && j.state === "running" && j !== job);
  return text(
    `${job.id} ${job.state === "queued" && ahead.length ? `is queued behind ${ahead[0].id}` : "is running in the background"}. ` +
      `When it ends, its result and pictures are posted in this chat and noted on your next message here. ` +
      `Don't poll; status with job_id ${job.id} if the user asks.`
  );
}

function status(args: Record<string, unknown>, ctx: AppContext) {
  const runner = pipelineRunner(ctx);
  if (args.job_id) {
    const job = runner.get(String(args.job_id));
    if (!job) return err(`no job ${String(args.job_id)} (jobs are forgotten on restart)`);
    const log = job.state === "running" ? runner.logTail(job, 1500).trim() : "";
    return text(details(job, runner) + (log ? `\nlog (end):\n${log}` : ""));
  }
  const jobs = runner.list().slice(0, 10);
  const names = [...ctx.config.getPipelines().keys()];
  return text(
    [`pipelines: ${names.join(", ") || "none configured"}`, ...(jobs.length ? jobs.map((j) => `${j.id}: ${jobLine(j)}`) : ["no jobs yet"])].join("\n")
  );
}

/** One tool, three actions: every tool's name sits in every session, so fewer is cheaper. */
export const pipelineTools: ToolDef[] = [
  {
    definition: {
      name: "pipeline",
      description:
        "Owner only. Run a configured local pipeline on this machine (action run), check jobs (status) or stop one (stop). " +
        "run: args is the argument list, never a shell string, starting with an allowed subcommand, e.g. [\"next\"]. " +
        "Commands that end within 20 s answer here with their JSON result; longer ones run as a background job (one at a time per pipeline): " +
        "when it ends, its pictures and next step are posted in chat_id and noted on your next message. Pictures the result shows are posted for you. " +
        "To hand pictures from the chat to the command, pass files (\"last_reply\": the brain's latest reply here; \"last_mine\": the user's latest; or message ids) " +
        "and write {files} in args where their folder goes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          chat_id: { type: "string", description: "The chat you're answering in: results and pictures are posted there." },
          pipeline: { type: "string", description: "run: the pipeline" },
          args: { type: "array", items: { type: "string" }, description: 'run: e.g. ["next", "aiko"] or ["deliver", "aiko", "<request>", "--from", "{files}"]' },
          files: {
            description: 'run: "last_reply", "last_mine", or message ids whose images replace {files}',
            anyOf: [{ type: "string", enum: ["last_reply", "last_mine"] }, { type: "array", items: { type: "string" } }],
          },
          job_id: { type: "string", description: "status (omit for the list) or stop" },
        },
        required: ["action", "chat_id"],
      },
    },
    handler: async (args, ctx, caller = { via: "local" }) => {
      if (!callerIsOwner(caller, args)) return err(OWNER_ONLY);
      const chatId = String(args.chat_id ?? "");
      if (!chatId) return err("chat_id is required");
      try {
        if (args.action === "run") return await run(args, ctx, chatId);
        if (args.action === "status") return status(args, ctx);
        if (args.action === "stop") {
          const id = String(args.job_id ?? "");
          return pipelineRunner(ctx).stop(id) ? text(`stopping ${id}`) : err(`${id} isn't queued or running`);
        }
        return err(`action must be one of ${ACTIONS.join(", ")}`);
      } catch (e) {
        if (e instanceof PipelineError) return err(e.message);
        throw e;
      }
    },
  },
];

/**
 * The tool as this config needs it: none when no pipeline is configured (its
 * name sits in every session), else with the configured names as the choices.
 * What each pipeline is for reaches a brain through `/pipeline` (the thread's
 * note), not here, so sessions that never use one don't pay for it.
 */
export function pipelineToolsFor(ctx: AppContext): ToolDef[] {
  const names = [...(ctx.config?.getPipelines().keys() ?? [])];
  if (!names.length) return [];
  return pipelineTools.map((t) => {
    const schema = t.definition.inputSchema as { properties: Record<string, object> };
    return {
      ...t,
      definition: {
        ...t.definition,
        inputSchema: { ...schema, properties: { ...schema.properties, pipeline: { type: "string", enum: names, description: "run: the pipeline" } } },
      },
    };
  });
}
