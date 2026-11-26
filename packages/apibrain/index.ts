/**
 * @choomfie/apibrain — make any OpenAI-compatible API a Choomfie brain.
 *
 * Describe a provider (`defineProvider`: base URL, key env var, models),
 * wrap it in an `ApiMember` (keys, health, quota, model catalog), and either
 * register it as a brain (`defineApiBrain`) or route across several with
 * `route()` and a `Classifier`. See docs/free-brain.md.
 */

export { defineProvider, resolveBaseURL, modelIsFree, modelHasVision, type ApiProviderSpec, type Limits, type ModelInfo } from "./provider.ts";
export { chatCompletion, listModels, classifyFailure, parseRateHeaders, parseDuration, stripThinking, type ChatMessage, type ContentPart, type FetchLike, type RateSnapshot } from "./client.ts";
export { ProviderError, AllUnavailableError, type ProviderErrorKind } from "./errors.ts";
export { Health, COOLDOWN_MS, shortDuration, type HealthOptions } from "./health.ts";
export { KeyPool, discoverKeys, type ApiKey } from "./keys.ts";
export { Quota, dayIn, msToMidnight } from "./quota.ts";
export { Catalog } from "./catalog.ts";
export { isChatModel, modelTraits, newestOnly, score, describeModel, NEEDS, type Need, type ModelTraits, type ScoreContext } from "./models.ts";
export { Availability, RECHECK_MS, type ModelCheck } from "./availability.ts";
export { CallLog, redact, nowIso, type CallEntry, type RouteEntry, type LogEntry } from "./calllog.ts";
export { ApiMember, rankAcross, type MemberOverrides, type ApiMemberDeps, type CompleteOptions, type Completion } from "./member.ts";
export { Transcript, type Turn, type Summary } from "./transcript.ts";
export { buildMessages, estimateTokens, isImage, recap, systemPrompt, userContent, IMAGE_TOKENS, type Persona, type UserContent } from "./context.ts";
export { maybeCompact, SUMMARY_PROMPT } from "./compact.ts";
export { route, parseTarget, targetKey, dedupeTargets, type Target, type Routed } from "./router.ts";
export {
  classifierPipeline,
  hardRules,
  keywordClassifier,
  parseClassification,
  zeroShotClassifier,
  zeroShotPrompt,
  type BucketDef,
  type Classification,
  type Classifier,
  type ClassifyInput,
  type PipelineStage,
} from "./classifier.ts";
export { embeddingClassifier, ollamaEmbed, cosine, scoreBuckets, embedText, StageUnavailable, type Embed } from "./embeddings.ts";
export { defineApiBrain, apiTurn, summarizer, personaOf, type ApiTurnInput } from "./define.ts";
