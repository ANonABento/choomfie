/**
 * Social platform provider interfaces.
 *
 * Each platform implements these interfaces. Primary provider is used first,
 * falls back to secondary on error.
 */

export interface VideoResult {
  title: string;
  url: string;
  channel: string;
  duration: string;
  views?: string;
  published?: string;
  thumbnail?: string;
}

export interface TranscriptSegment {
  text: string;
  start?: number;
  duration?: number;
}

export interface YouTubeProvider {
  name: string;
  /** Search for videos */
  search(query: string, limit?: number): Promise<VideoResult[]>;
  /** Get video transcript/captions */
  getTranscript(videoUrl: string): Promise<TranscriptSegment[]>;
  /** Get video metadata */
  getInfo(videoUrl: string): Promise<VideoResult | null>;
}

export interface RedditPost {
  title: string;
  url: string;
  subreddit: string;
  author: string;
  score: number;
  comments: number;
  selftext?: string;
  created: string;
  permalink: string;
}

export interface RedditComment {
  author: string;
  body: string;
  score: number;
  created: string;
}

export interface RedditProvider {
  name: string;
  /** Search posts across reddit or in a subreddit */
  search(query: string, subreddit?: string, limit?: number): Promise<RedditPost[]>;
  /** Get top/hot posts from a subreddit */
  getPosts(subreddit: string, sort?: "hot" | "top" | "new", limit?: number): Promise<RedditPost[]>;
  /** Get comments on a post */
  getComments(postUrl: string, limit?: number): Promise<RedditComment[]>;
}
