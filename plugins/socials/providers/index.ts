/**
 * Social provider factory — primary + fallback for each platform.
 *
 * If primary fails, automatically retries with fallback provider.
 * Config: "socials": { "youtube": "yt-dlp", "reddit": "reddit-api" }
 */

import type { YouTubeProvider, RedditProvider } from "./types.ts";
import { ytdlpProvider, youtubeApiProvider } from "./youtube/index.ts";
import { redditApiProvider, redditScraperProvider } from "./reddit/index.ts";

// --- Registries ---

const youtubeProviders: Record<string, YouTubeProvider> = {
  "yt-dlp": ytdlpProvider,
  "youtube-api": youtubeApiProvider,
};

const redditProviders: Record<string, RedditProvider> = {
  "reddit-api": redditApiProvider,
  "reddit-scraper": redditScraperProvider,
};

// --- Fallback order ---

const youtubeFallbackOrder = ["yt-dlp", "youtube-api"];
const redditFallbackOrder = ["reddit-api", "reddit-scraper"];

// --- Wrapper with auto-fallback ---

export function getYouTubeProvider(preferred?: string): YouTubeProvider {
  const order = preferred
    ? [preferred, ...youtubeFallbackOrder.filter((p) => p !== preferred)]
    : youtubeFallbackOrder;

  return createFallbackProxy(order, youtubeProviders) as YouTubeProvider;
}

export function getRedditProvider(preferred?: string): RedditProvider {
  const order = preferred
    ? [preferred, ...redditFallbackOrder.filter((p) => p !== preferred)]
    : redditFallbackOrder;

  return createFallbackProxy(order, redditProviders) as RedditProvider;
}

/** Creates a proxy that tries each provider in order on method failure */
function createFallbackProxy<T extends { name: string }>(
  order: string[],
  providers: Record<string, T>
): T {
  const validOrder = order.filter((name) => providers[name]);
  const primary = providers[validOrder[0]];
  if (!primary) throw new Error(`Provider "${order[0]}" not found`);

  return new Proxy(primary, {
    get(target, prop: string) {
      if (prop === "name") return target.name;
      const original = (target as any)[prop];
      if (typeof original !== "function") return original;

      return async (...args: any[]) => {
        for (const name of validOrder) {
          const provider = providers[name];
          if (!provider) continue;
          try {
            return await (provider as any)[prop](...args);
          } catch (e) {
            console.error(
              `Social provider ${name}.${prop} failed: ${e}. Trying next...`
            );
          }
        }
        throw new Error(
          `All providers failed for ${prop}. Tried: ${validOrder.join(", ")}`
        );
      };
    },
  });
}

export type { YouTubeProvider, RedditProvider };
