/**
 * Labelled messages for `bun run apibrain eval free`: which bucket each one
 * should go to. Written by hand (not taken from real chats) and kept apart
 * from the buckets' `examples`, so a classifier that only memorised those
 * doesn't look good here. `alt` is a second bucket that would also be fine
 * (a GitHub repo task could be cloud or local work).
 *
 * Short greetings and images are left out: hard rules decide those, not the
 * classifier.
 */

export interface EvalCase {
  text: string;
  bucket: string;
  alt?: string;
  recent?: { role: "user" | "assistant"; content: string }[];
}

export const EVAL_SET: EvalCase[] = [
  // chat
  { text: "yo how's your day been going so far", bucket: "chat" },
  { text: "do you think pineapple belongs on pizza", bucket: "chat" },
  { text: "what's 15% of 80", bucket: "chat" },
  { text: "lmaooo no way that actually happened", bucket: "chat" },
  { text: "can you recommend a good sci-fi book", bucket: "chat", alt: "quality" },
  { text: "how do you say thank you in japanese", bucket: "chat" },
  { text: "i'm feeling kinda down today tbh", bucket: "chat" },
  { text: "what's the difference between a crocodile and an alligator", bucket: "chat" },
  { text: "give me a fun fact about octopuses", bucket: "chat" },
  { text: "who wrote pride and prejudice", bucket: "chat" },

  // quality
  { text: "write me a short story about a robot who learns to paint", bucket: "quality" },
  { text: "should I take the job offer with higher pay or the one with better work-life balance? here's the details", bucket: "quality" },
  { text: "explain the causes of the 2008 financial crisis step by step", bucket: "quality" },
  { text: "proofread this email to my landlord and make it more polite", bucket: "quality" },
  { text: "what's the probability of getting at least one six in four dice rolls, show your work", bucket: "quality" },
  { text: "give me a 12 week marathon training plan for a beginner", bucket: "quality" },
  { text: "summarize the main ideas of stoicism and how to apply them", bucket: "quality" },
  { text: "help me structure my thesis argument about urban housing policy", bucket: "quality" },
  { text: "is it smarter to pay off my student loans early or invest", bucket: "quality" },
  { text: "write a wedding toast for my brother, funny but heartfelt", bucket: "quality" },

  // code
  { text: "how do I center a div with flexbox", bucket: "code" },
  { text: "what's wrong with this: for i in range(len(x)): x.remove(x[i])", bucket: "code" },
  { text: "write a python script that renames files based on their creation date", bucket: "code", alt: "local" },
  { text: "explain the difference between let, const and var", bucket: "code" },
  { text: "segfault when I free this pointer twice, why", bucket: "code" },
  { text: "give me a regex for validating email addresses", bucket: "code" },
  { text: "how do I write a SQL join that keeps rows with no match", bucket: "code" },
  { text: "what's the time complexity of quicksort worst case", bucket: "code" },
  { text: "git says detached HEAD, how do I get back to my branch", bucket: "code", alt: "local" },
  { text: "convert this callback code to promises", bucket: "code" },

  // media
  { text: "can you make a picture of a dragon sleeping on a pile of gold", bucket: "media" },
  { text: "generate an album cover for a synthwave record", bucket: "media" },
  { text: "make me a happy birthday song for my mom named Linda", bucket: "media" },
  { text: "create an animated video of a paper airplane flying through a city", bucket: "media" },
  { text: "draw a cute cartoon of a penguin drinking coffee", bucket: "media" },
  { text: "remove the background from this photo and make it transparent", bucket: "media" },
  { text: "make a ringtone that sounds like birds chirping", bucket: "media" },
  { text: "design a poster for our school bake sale", bucket: "media" },
  { text: "read this paragraph out loud in a british accent", bucket: "media" },
  { text: "make a meme of a cat judging someone's code", bucket: "media" },

  // agentic
  { text: "open a pull request on my repo that adds dark mode", bucket: "agentic" },
  { text: "make me a portfolio site and host it somewhere", bucket: "agentic" },
  { text: "model a replacement knob for my stove in CAD, 6mm D-shaft", bucket: "agentic" },
  { text: "go through the issues on my github project and label them", bucket: "agentic" },
  { text: "find three apartments under 2000 in toronto on rental sites and compare them", bucket: "agentic", alt: "research" },
  { text: "build a discord bot that posts the weather every morning", bucket: "agentic", alt: "code" },
  { text: "write and run a scraper that collects all the recipes from this site", bucket: "agentic" },
  { text: "fix the bug in issue #42 and push the fix", bucket: "agentic", alt: "local" },
  { text: "make an STL of a cable clip that fits a 5mm cable", bucket: "agentic" },
  { text: "create a google sheet that tracks my expenses and fill in last month", bucket: "agentic" },

  // local
  { text: "how big is my photos library on this mac", bucket: "local" },
  { text: "kill whatever is hogging my cpu right now", bucket: "local" },
  { text: "show me the last 20 lines of the log file in ~/choomfie/logs", bucket: "local" },
  { text: "is docker running on my computer", bucket: "local" },
  { text: "zip up the screenshots folder on my desktop", bucket: "local" },
  { text: "run npm install in my project folder and tell me if it errors", bucket: "local" },
  { text: "what's my local ip address", bucket: "local" },
  { text: "move all pdfs from downloads into documents/papers", bucket: "local" },
  { text: "check if my ssh key is set up on this machine", bucket: "local" },
  { text: "update homebrew and all my packages", bucket: "local" },

  // research
  { text: "what's the weather in toronto tomorrow", bucket: "research" },
  { text: "who is the current prime minister of the uk", bucket: "research", alt: "chat" },
  { text: "what are people saying about the new zelda game", bucket: "research" },
  { text: "find the cheapest flights from vancouver to tokyo in march", bucket: "research", alt: "agentic" },
  { text: "what's nvidia's stock doing today", bucket: "research" },
  { text: "are there any concerts in montreal this weekend", bucket: "research" },
  { text: "latest version of python and what changed", bucket: "research" },
  { text: "give me recent studies on microplastics in the brain with links", bucket: "research" },
  { text: "did the fed change interest rates this month", bucket: "research" },
  { text: "what time does costco close today", bucket: "research" },

  // follow-ups that only make sense with the turn before
  {
    text: "now do the same for the other one",
    bucket: "media",
    recent: [{ role: "user", content: "make me a picture of a red fox in the snow" }],
  },
  {
    text: "ok try it again but faster",
    bucket: "code",
    recent: [{ role: "user", content: "write a function that finds prime numbers up to n in javascript" }],
  },
  {
    text: "and what about tomorrow?",
    bucket: "research",
    recent: [{ role: "user", content: "what's the weather in paris today" }],
  },
];
