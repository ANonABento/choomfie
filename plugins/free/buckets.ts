/**
 * The kinds of message the free brain tells apart, and what each needs.
 *
 * One table: the zero-shot classifier's prompt is built from `description`,
 * and each bucket names a **need** (fast, strong, vision, long), never a
 * model. Which models meet a need is worked out from each provider's live
 * model list (`@choomfie/apibrain` models.ts), so nothing here goes stale
 * when a provider renames or retires a model. `brains` are web brains tried
 * first for that kind of work (on a first message) or offered with a button:
 * Waymond works in its own cloud sandbox, a harness (Antigravity, OpenCode)
 * on this computer, a media site makes images, music or video (its files come
 * back as attachments).
 *
 * `examples` are what the embeddings classifier compares a message to:
 * typical messages, varied in wording. Keep them out of `eval-set.ts`.
 *
 * config.json `free.buckets.<id>` pins a bucket to explicit targets
 * (`member[:model]`; `@bucket` splices another bucket's pins).
 */

import type { BucketDef, Need } from "@choomfie/apibrain";
import { PROVIDERS } from "./providers/index.ts";

export interface Bucket extends BucketDef {
  need: Need;
  /** Web brains for this kind of work, before any API model. */
  brains: string[];
  /** Explicit targets from config, replacing need-based routing. */
  targets?: string[];
}

export const BUCKETS: Bucket[] = [
  {
    id: "chat",
    label: "Chat",
    description:
      "small talk, greetings, opinions, jokes, quick factual questions, short everyday help",
    need: "fast",
    examples: [
      "hey what's up",
      "good morning! how are you doing",
      "lol that's hilarious",
      "what's your favorite movie",
      "thanks, that helped a lot",
      "how many ounces are in a cup",
      "tell me a joke about cats",
      "what's the capital of australia",
      "any tips for falling asleep faster",
      "I'm bored, talk to me",
    ],
    brains: [],
  },
  {
    id: "quality",
    label: "Think it through",
    description:
      "needs careful thinking or good writing: analysis, comparisons, plans, long explanations, math, editing or rewriting text",
    need: "strong",
    examples: [
      "write a thoughtful essay on whether remote work is better than office work",
      "compare postgres and mongodb for a startup and tell me which to pick",
      "help me plan a two week trip through japan on a budget",
      "rewrite this paragraph so it sounds more professional",
      "explain in detail how vaccines train the immune system",
      "what are the pros and cons of buying vs renting a house",
      "solve this: a train leaves at 3pm going 60 mph, when does it catch one that left at 1pm going 40",
      "edit my cover letter and tighten the wording",
      "break down the arguments for and against universal basic income",
      "outline a business plan for a small bakery",
    ],
    brains: [],
  },
  {
    id: "code",
    label: "Code",
    description:
      "about programming, answered in the reply itself: explain, write, review or debug code, errors, shell commands, regex, SQL",
    need: "strong",
    examples: [
      "why does this python function return None",
      "write a typescript function that debounces another function",
      "what does this regex match: ^\\d{3}-\\d{4}$",
      "I'm getting TypeError: cannot read properties of undefined",
      "how do I reverse a linked list in java",
      "review this SQL query for performance problems",
      "what's the bash command to find files larger than 1GB",
      "explain what async/await does in javascript",
      "convert this for loop into a list comprehension",
      "my react component re-renders forever, here's the code",
    ],
    brains: [],
  },
  {
    id: "media",
    label: "Make media",
    description:
      "asks to MAKE or EDIT media, not talk about it: generate or edit an image, picture, drawing, logo or sticker; make music, a song or a sound; a video or animation; a voice clip or text read aloud",
    need: "strong",
    // Only sites that actually generate media (ChatGPT, Hugging Face Spaces next). Not Waymond: it
    // can't make a song or a picture, so when these are spent a text model answers and says so.
    examples: [
      "draw me a cat wearing a wizard hat",
      "generate an image of a sunset over the ocean",
      "make a song about my dog barking at the mailman",
      "create a logo for my coffee shop called Bean There",
      "make a short video of a rocket launching",
      "compose a lofi beat for studying",
      "edit this photo to make the sky purple",
      "make a sticker of a sleepy frog",
      "generate a picture of a cyberpunk city at night",
      "turn this text into a voice clip",
    ],
    brains: ["gemini-web"],
  },
  {
    id: "agentic",
    label: "Do the work",
    description:
      "asks the assistant to DO something with tools in the cloud, not just answer in text: change a GitHub repo; build an app or a website; a 3D/CAD part; browse sites; multi-step tasks",
    need: "strong",
    examples: [
      "add a login page to my github repo and open a PR",
      "build me a landing page website and deploy it",
      "design a 3D printable phone stand as an STL",
      "go to amazon and find the cheapest usb-c hub",
      "clone the repo and fix the failing CI",
      "make a CAD model of a bracket with two mounting holes",
      "set up a new nextjs project with tailwind and push it to github",
      "browse hacker news and summarize the top 5 posts",
      "refactor the whole codebase in my repo to use ESM",
      "create a website for my band with a tour dates page",
    ],
    brains: ["waymond"],
  },
  {
    id: "local",
    label: "On this computer",
    description:
      "work that has to happen on the user's own computer: run commands or scripts here, read or change local files and folders, a project or repo on this machine, installed programs, checking this machine (disk, processes, ports)",
    need: "strong",
    examples: [
      "how much free disk space do I have",
      "what's running on port 3000 on my machine",
      "list the files in my downloads folder",
      "run the tests in my project here",
      "delete the node_modules folders under ~/code",
      "check which processes are using the most memory",
      "open the choomfie folder and run git status",
      "install ffmpeg on this mac",
      "rename all the jpgs on my desktop by date",
      "what version of node do I have installed",
    ],
    brains: ["antigravity", "opencode"],
  },
  {
    id: "research",
    label: "Research",
    description:
      "needs current or sourced information from the web: news, today's prices, recent releases, looking something up, citations",
    need: "strong",
    // Gemini searches Google for free; Waymond (paid credits) after it.
    examples: [
      "what's the latest news about the mars mission",
      "what is the price of bitcoin right now",
      "who won the game last night",
      "find me sources on the health effects of intermittent fasting",
      "what new phones were announced this week",
      "look up the opening hours of the louvre",
      "what's the current mortgage rate in canada",
      "search for reviews of the new macbook",
      "what happened in the election today",
      "is there a recall on my car model",
    ],
    brains: ["gemini-web", "waymond"],
  },
  {
    id: "vision",
    label: "Images",
    description: "about an attached image",
    need: "vision",
    brains: [],
  },
  {
    id: "long",
    label: "Long input",
    description: "a very long document or message to read",
    need: "long",
    brains: [],
  },
];

/** When a bucket's list is spent: any provider that can answer at all (each with its own best model). */
export const DEFAULT_PRIORITY = PROVIDERS.map((p) => p.id);
