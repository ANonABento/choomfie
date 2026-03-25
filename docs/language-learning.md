# Language Learning Feature

Japanese language tutor mode for Choomfie — voice conversation practice, SRS vocabulary drills, pronunciation feedback, and more.

> Last updated: 2026-03-24

---

## Overview

No existing Discord bot combines AI tutoring + voice (STT/TTS) + SRS + Japanese-specific features in one package. This is a genuine gap.

---

## Feature Phases

### Phase 1: Core Text Features

| Feature | Difficulty | Description |
|---------|-----------|-------------|
| **AI Conversation Tutor** | Medium | LLM-powered Japanese conversation in text. System prompt defines JLPT level, correction style. Structured JSON corrections. |
| **Dictionary Lookup** | Easy | `/jisho <word>` — Jisho API, returns readings, meanings, JLPT level, examples |
| **Kana/Kanji Quiz** | Easy | Daily quiz with buttons. "What is the reading of 食べる?" |
| **Grammar Correction** | Medium | User posts Japanese, bot corrects with explanations |
| **JLPT Level Setting** | Easy | `/setlevel N5` — adjusts all content difficulty |
| **Immersion Mode** | Easy | Toggle: bot only responds in Japanese, no English |

### Phase 2: SRS & Progression

| Feature | Difficulty | Description |
|---------|-----------|-------------|
| **Vocabulary SRS** | Medium | SM-2 algorithm, daily review DMs, button-based grading. Pre-built JLPT N5-N1 decks. |
| **Kanji SRS** | Medium | Kanji cards — show kanji, recall reading + meaning |
| **Progress Tracking** | Medium | `/stats` — cards learned, streak, accuracy, JLPT readiness |
| **Custom Decks** | Easy | `/addcard front back` — user creates own cards |
| **WaniKani Sync** | Easy | Connect WaniKani API key, import SRS state |

### Phase 3: Voice Features

| Feature | Difficulty | Description |
|---------|-----------|-------------|
| **Voice Conversation** | Hard | Join VC, speak Japanese, bot transcribes (Whisper), responds via LLM, speaks (VOICEVOX). Full loop. |
| **Pronunciation Scoring** | Hard | Azure Pronunciation Assessment or DIY F0 analysis. Per-phoneme scores. |
| **Listening Comprehension** | Medium | Bot speaks a sentence, user types/says what they heard |
| **Shadowing Practice** | Medium | Bot plays sentence, user repeats, bot compares. Progressive speed. |
| **Pitch Accent Drills** | Very Hard | Extract F0 contour from user audio, compare to reference patterns |

### Phase 4: Advanced

| Feature | Difficulty | Description |
|---------|-----------|-------------|
| **Reading Practice** | Medium | Graded passages + comprehension questions |
| **Role-play Scenarios** | Medium | Ordering food, asking directions, job interview. Bot plays NPC. |
| **Multiplayer Quizzes** | Medium | Competitive vocab/kanji quizzes. Leaderboard. |
| **JLPT Mock Tests** | Medium | Timed test sections matching JLPT format |
| **Kanji Recognition** | Hard | User draws/uploads kanji image, bot recognizes and grades |

---

## Tools & APIs

| Tool/API | Purpose | Type |
|----------|---------|------|
| **Jisho API** | Dictionary lookup (readings, meanings, JLPT level) | REST (jisho.org/api/v1/) |
| **KuromojiJS / kuroshiro** | Japanese text tokenization + readings | npm package |
| **WanaKana** | Romaji ↔ Hiragana ↔ Katakana conversion | npm (`wanakana`) |
| **Kanji Alive API** | Kanji details, stroke order SVGs | REST API |
| **JMdict/EDICT** | Comprehensive JP-EN dictionary | XML → SQLite |
| **Tatoeba API** | Example sentences (millions of JP-EN pairs) | REST API |
| **Kanjium** | Pitch accent data for ~65k words | GitHub dataset |
| **VOICEVOX** | Japanese TTS (cute voices, free) | Local HTTP server |
| **Whisper** | Japanese STT (API or local whisper.cpp) | API or local binary |
| **Azure Pronunciation Assessment** | Pronunciation scoring per phoneme | REST API ($0.016/min) |

### npm Packages

```bash
bun add wanakana          # Romaji/kana conversion
bun add kuroshiro         # Japanese text analysis
bun add @discordjs/voice  # Voice channel
bun add prism-media       # Audio transcoding
bun add @discordjs/opus   # Opus decode/encode
```

---

## LLM Tutor Design

### System Prompt Structure

```
You are a Japanese language tutor. Student's level: {jlptLevel}.

Rules:
- Respond in Japanese appropriate for their level
- Provide corrections for errors in their input
- Return structured JSON:
{
  "response_jp": "Japanese response",
  "response_en": "English translation (omit in immersion mode)",
  "furigana": "Response with furigana: 食[た]べる",
  "corrections": [
    { "original": "...", "corrected": "...", "type": "grammar|vocabulary|particle|formality", "explanation": "..." }
  ],
  "new_words": [
    { "word": "新しい", "reading": "あたらしい", "meaning": "new" }
  ]
}
```

### Correction Types
- **Grammar** — verb conjugation, sentence structure
- **Vocabulary** — wrong word choice
- **Particle** — は vs が, に vs で, etc.
- **Formality** — casual vs polite vs keigo mismatch

---

## SRS Algorithm (SM-2)

Same algorithm as Anki:

```typescript
interface Card {
  id: string;
  userId: string;
  front: string;         // e.g., "食べる"
  back: string;          // e.g., "to eat (taberu)"
  reading: string;       // "たべる"
  jlptLevel: number;     // 5, 4, 3, 2, 1
  easeFactor: number;    // starts at 2.5
  interval: number;      // days until next review
  repetitions: number;
  nextReview: Date;
  tags: string[];        // ["verb", "ichidan", "n5"]
}
```

### Pre-Built Decks
- JLPT N5: ~800 words
- JLPT N4: ~1,500 words
- JLPT N3: ~3,000 words
- JLPT N2: ~6,000 words
- JLPT N1: ~10,000 words
- Core 2k/6k/10k frequency-ordered

### Discord Integration
- Daily DM: "You have 15 cards due for review"
- Buttons: `[知っている (Know)] [わからない (Don't Know)] [Skip]`
- Streak tracking, daily goals, weekly summary

---

## Voice Pipeline (Japanese-Specific)

```
User speaks Japanese in VC
  → Discord Opus → PCM 48kHz
  → Whisper STT (language: "ja") → Japanese transcript
  → Claude (tutor system prompt) → response + corrections JSON
  → VOICEVOX (cute JP voice) → WAV audio
  → ffmpeg → Opus → Discord playback
  + corrections sent as text message in channel
```

### Pronunciation Assessment Options

**Option A: Azure (turnkey, $0.016/min)**
- Per-phoneme accuracy, fluency, completeness, prosody scores
- Supports Japanese
- API: `speechsdk.PronunciationAssessmentConfig`

**Option B: DIY (free but complex)**
1. STT user's speech → transcript
2. Compare to expected text (fuzzy match)
3. LLM evaluates both texts for detailed feedback
4. For pitch accent: extract F0 contour, compare to reference

### Pitch Accent (Stretch Goal)
- Data: Kanjium dataset (~65k words with pitch notation)
- Store in SQLite, lookup by word
- Four patterns: 平板 (heiban), 頭高 (atamadaka), 中高 (nakadaka), 尾高 (odaka)
- Requires F0 extraction from user audio (libraries: pyin, crepe)

---

## Cost Estimate (Per Active User/Month)

| Component | Cost |
|-----------|------|
| LLM text tutoring (~500 msgs/mo) | ~$0.50-2.00 |
| Whisper STT (~60 min voice/mo) | ~$0.36 |
| VOICEVOX TTS (self-hosted) | Free |
| Azure Pronunciation (~60 min/mo) | ~$0.96 |
| **Total** | **~$1.80-3.30** |

With free alternatives (whisper.cpp local + skip Azure): **$0.50-2.00/mo** (LLM only)

---

## Security

| Concern | Mitigation |
|---------|------------|
| **Who can use** | All allowlisted users (learning is collaborative) |
| **User data** | SRS progress, conversation history stored in SQLite. Offer `/deletedata` command. |
| **Voice privacy** | Don't store recorded audio. Process in memory only. |
| **API costs** | Rate limit voice sessions (e.g., 30 min/day). Text is cheap. |
| **Content** | Tutor system prompt constrains to educational content only |

---

## Reference Projects

| Project | What it does |
|---------|-------------|
| [mistval/kotoba](https://github.com/mistval/kotoba) | Japanese quiz bot for Discord (no AI, no voice) |
| [VOICEVOX/voicevox_engine](https://github.com/VOICEVOX/voicevox_engine) | Japanese TTS engine |
| [mifunetoshiro/kanjium](https://github.com/mifunetoshiro/kanjium) | Pitch accent dataset |
| [WaniKani API](https://docs.api.wanikani.com/20170710/) | Kanji SRS sync |
| [Jisho API](https://jisho.org/api/v1/search/words) | Dictionary lookups |
