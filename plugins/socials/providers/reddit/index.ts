/**
 * Reddit providers — OAuth API client (primary) + JSON scraper (fallback).
 */

export { redditApiProvider, RedditClient, getRedditApiClient, getRedditClient, destroyRedditClient } from "./api.ts";
export { redditScraperProvider } from "./scraper.ts";
