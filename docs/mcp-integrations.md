# MCP Integrations Research

Research into external MCP servers and tools that could enhance Choomfie's capabilities. Each section covers the best options, setup requirements, costs, and recommended approach.

> Last updated: 2026-03-24

---

## Security Principles

Every integration follows these baseline rules. Per-integration security details are in each section.

### Access Tiers

| Tier | Who | Integrations |
|------|-----|-------------|
| **Owner-only** | Only the bot owner (via Choomfie access control `role="owner"`) | Google Workspace, Notion, voice cloning, audio download, any write operations |
| **All users** | Anyone in the allowlist | Weather, YouTube search/transcripts, image gen (with rate limits), TTS (with rate limits) |

### General Rules

1. **API keys in env vars only.** Never in config files, never committed to git. Use `.env` + `.gitignore`.
2. **Rate limit everything.** Every user-facing integration needs per-user rate limits to prevent abuse and cost runaway.
3. **Sensitive data stays in DMs.** Google calendar events, emails, Notion content, and any personal data must only be sent to DM channels, never public server channels.
4. **Minimal permissions.** Request the smallest OAuth scopes possible. Share only necessary Notion pages. Use read-only access unless write is explicitly needed.
5. **Auto-cleanup temp files.** Generated images, downloaded audio, TTS output -- delete after sending. Use `/tmp/` with UUID filenames.
6. **Content filtering.** Apply filters before image gen prompts and TTS input. Block NSFW, slurs, and harmful content.
7. **Input sanitization.** Never pass raw user input to shell commands. MCP servers handle this, but verify. Validate URLs against expected domains.
8. **Spending caps.** Set daily/monthly limits on paid APIs (OpenAI, ElevenLabs, Together AI) via provider dashboards.

---

## 1. Image Generation

Generate images from text prompts and send them as Discord attachments.

### Recommended: Together AI Flux MCP (Free/Cheap)

- **Repo:** [manascb1344/together-mcp-server](https://github.com/manascb1344/together-mcp-server)
- **Models:** Flux.1 Schnell (free tier on Together AI)
- **Cost:** $0.00 for Flux.1 Schnell-Free
- **Setup:** `npx together-mcp@latest` with `TOGETHER_API_KEY` env var
- **Saves to disk:** Yes -- `image_path` parameter saves PNG directly
- **Why:** Free, fast (~1s generation), saves to disk natively (critical for Discord attachments)

### Alternative: MCPollinations (Zero Config)

- **Repo:** [pinkpixel-dev/MCPollinations](https://github.com/pinkpixel-dev/MCPollinations)
- **Models:** Flux and others via Pollinations API
- **Cost:** Free, no API key required
- **Setup:** `npx @pinkpixel/mcpollinations` -- zero config
- **Saves to disk:** Yes -- configurable `OUTPUT_DIR`
- **Why:** Best for prototyping, literally zero setup

### Premium: OpenAI GPT Image MCP

- **Repo:** [SureScaleAI/openai-gpt-image-mcp](https://github.com/SureScaleAI/openai-gpt-image-mcp) (97 stars)
- **Models:** gpt-image-1 (DALL-E successor)
- **Cost:** ~$0.04-0.08/image
- **Saves to disk:** Yes -- auto-saves when base64 exceeds 1MB
- **Why:** Highest quality, supports image editing/inpainting

### Self-Hosted: Stable Diffusion WebUI MCP

- **Repo:** [Ichigo3766/image-gen-mcp](https://github.com/Ichigo3766/image-gen-mcp)
- **Cost:** Free (requires GPU hardware)
- **Why:** Zero API cost, use any model (custom LoRAs, checkpoints)

### Integration Pattern

```
User: "draw me a cat in space"
→ MCP tool call with image_path="/tmp/gen_{uuid}.png"
→ Wait for response
→ reply({ files: ["/tmp/gen_{uuid}.png"] })
→ Delete temp file
```

### Security

| Concern | Mitigation |
|---------|------------|
| **Who can use** | Owner-only by default (Choomfie access control). If opened to users, enforce role check before calling image gen tools. |
| **NSFW/harmful content** | Together AI and OpenAI have built-in content filters. MCPollinations relies on upstream Pollinations filters. Stable Diffusion (self-hosted) has NO filters -- must add your own. Add a prompt blocklist for slurs, violence, CSAM keywords. |
| **Cost abuse** | Rate limit image gen per user (e.g., 10/day). Free tiers have natural rate limits. For paid APIs, set spending caps in provider dashboard. |
| **Disk space** | Auto-delete generated images after sending to Discord. Use `/tmp/` with UUID filenames. Set max file size limit. |
| **Prompt injection** | Sanitize user prompts -- strip any MCP/system-level instructions. Keep image prompts as plain text descriptions only. |
| **API key exposure** | Store API keys in env vars, never in config files committed to git. Use `.env` with `.gitignore`. |

---

## 2. YouTube

Search videos, fetch transcripts, extract audio for voice channel playback.

### Recommended: yt-dlp MCP (All-in-One)

- **Repo:** [kevinwatt/yt-dlp-mcp](https://github.com/kevinwatt/yt-dlp-mcp) (225 stars)
- **Auth:** None (free, uses yt-dlp)
- **Features:** Search, metadata, transcripts, **audio extraction** (M4A/MP3), video download
- **Setup:** Install `yt-dlp`, then `npx -y @kevinwatt/yt-dlp-mcp@latest`
- **Why:** Only option that can download audio files for Discord voice channel playback. No API key needed.

### Supplementary: Full YouTube API Server

- **Repo:** [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server) (463 stars)
- **Auth:** YouTube Data API v3 key (free: 10,000 units/day)
- **Features:** Structured search results, channel stats, playlist management, multi-language transcripts
- **Setup:** `npx -y zubeid-youtube-mcp-server` with `YOUTUBE_API_KEY`
- **Why:** Richer metadata than yt-dlp (view counts, likes, channel details)

### Transcript-Only (No API Key)

- **Repo:** [kimtaeyoon83/mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) (502 stars)
- **Features:** Transcript extraction with ad/sponsorship filtering
- **Setup:** `npx -y @kimtaeyoon83/mcp-server-youtube-transcript`
- **Why:** Zero config, clean transcripts with built-in ad filtering

### Advanced: YouTube Intelligence

- **Repo:** [JangHyuckYun/mcp-youtube-intelligence](https://github.com/JangHyuckYun/mcp-youtube-intelligence) (41 stars)
- **Features:** Server-side summarization, sentiment analysis, topic segmentation, entity extraction
- **Why:** Reduces token usage dramatically (transcripts summarized server-side)

### Security

| Concern | Mitigation |
|---------|------------|
| **Who can use** | Search/transcripts: safe for all users. Audio download: owner-only (disk + bandwidth cost). |
| **Malicious URLs** | Validate URLs match `youtube.com` or `youtu.be` domains only. Reject arbitrary URLs passed to yt-dlp (it supports 1000+ sites -- restrict to YouTube only). |
| **Disk space abuse** | Audio/video downloads can be large. Set max duration limit (e.g., 15 min). Auto-delete after playback. Use `/tmp/` with cleanup cron. |
| **Copyright** | Downloading YouTube content may violate YouTube ToS. Use for personal/ephemeral playback only. Don't store or redistribute. |
| **API quota** | YouTube Data API free tier is 10,000 units/day. Monitor usage. yt-dlp has no quota but YouTube may rate-limit/block IPs. |
| **Command injection** | yt-dlp accepts URLs as arguments -- never pass unsanitized user input directly to shell. MCP server handles this, but verify it escapes properly. |

---

## 3. Voice (TTS + STT)

Text-to-speech for voice messages/channels, speech-to-text for transcribing voice input.

### TTS Recommended: OpenAI TTS

- **Repo:** [nakamurau1/tts-mcp](https://mcpservers.org/servers/nakamurau1/tts-mcp)
- **Voices:** alloy, nova, echo, fable, shimmer, + 7 more
- **Cost:** $15/1M chars (tts-1), $30/1M chars (tts-1-hd)
- **Output:** MP3 files
- **Why:** Best balance of cost, quality, and latency

### TTS Budget: Kokoro (Local, Free)

- **Repo:** [kristofferv98/MCP_tts_server](https://github.com/kristofferv98/MCP_tts_server)
- **Voices:** 54 voices across 8 languages (Kokoro-82M model)
- **Cost:** Free (local inference)
- **Why:** Zero ongoing cost, wraps both Kokoro and OpenAI as fallback

### TTS Premium: ElevenLabs (Official MCP)

- **Repo:** [elevenlabs/elevenlabs-mcp](https://github.com/elevenlabs/elevenlabs-mcp)
- **Features:** TTS, voice cloning, voice transformation, STT, music composition
- **Cost:** Free tier 10k chars/month, paid $22-330/month
- **Why:** Highest quality, voice cloning capability, includes STT too

### TTS Multi-Engine: blacktop/mcp-tts

- **Repo:** [blacktop/mcp-tts](https://github.com/blacktop/mcp-tts)
- **Engines:** macOS `say` (free), ElevenLabs, Google Gemini, OpenAI
- **Why:** Flexibility to switch between engines

### STT Recommended: Local Whisper

- **Repo:** [SmartLittleApps/local-stt-mcp](https://github.com/SmartLittleApps/local-stt-mcp)
- **Engine:** whisper.cpp, optimized for Apple Silicon
- **Cost:** Free
- **Performance:** 5-min audio in 38 seconds (15.8x real-time)
- **Features:** Speaker diarization, universal audio format support
- **Why:** Free, fast, local, privacy-preserving

### STT Cloud Alternative

- **Repo:** [arcaputo3/mcp-server-whisper](https://github.com/arcaputo3/mcp-server-whisper)
- **Engine:** OpenAI Whisper API
- **Cost:** $0.006/min
- **Why:** Simpler setup, high accuracy

### Discord Voice Integration

Two approaches for Discord:

**A. Voice Channels** (`@discordjs/voice`):
- Join channel, stream TTS audio, capture STT from users
- Dependencies: `@discordjs/voice`, `@discordjs/opus`, `ffmpeg-static`, `libsodium-wrappers`
- Audio must be 16-bit 48kHz PCM (ffmpeg handles conversion)

**B. Voice Messages** (text channel, async):
- Generate OGG/Opus file, send with `flags: 8192` (IS_VOICE_MESSAGE)
- Lighter weight, no voice channel connection needed
- Must encode as OGG/Opus (not Vorbis) for mobile compatibility

### Cost Comparison

| Provider | Cost | Latency | Quality |
|----------|------|---------|---------|
| Kokoro (local) | Free | 50-200ms | Good |
| OpenAI TTS | $15/1M chars | 200-500ms | Very Good |
| ElevenLabs | $22-330/mo | 200-600ms | Best |
| macOS say | Free | <50ms | Basic |

### Security

| Concern | Mitigation |
|---------|------------|
| **Who can use** | TTS: all users (low cost per message). STT: owner-only or trusted users (processes voice data). Voice channel join: owner-only. |
| **Abuse / spam** | Rate limit TTS requests (e.g., 5/min per user). Set max text length for TTS (e.g., 500 chars). Prevents someone spamming voice channel with generated speech. |
| **Voice cloning** | ElevenLabs supports voice cloning -- restrict to owner-only. Never clone someone's voice without consent. Do not expose cloning tools to non-owners. |
| **Privacy (STT)** | Voice data from Discord channels contains personal speech. Process locally when possible (whisper.cpp). If using cloud STT (OpenAI Whisper API), data is sent to third party. Inform users if STT is active in a voice channel. |
| **Disk space** | Audio files can accumulate. Auto-delete TTS output after sending. Clean up STT transcripts after processing. |
| **Cost runaway** | OpenAI TTS and ElevenLabs charge per character/minute. Set daily spending caps. Monitor usage. Kokoro (local) has zero cost risk. |
| **Content filtering** | TTS will speak whatever text is given. Apply the same content filters as text messages before generating speech. |

---

## 4. Google Workspace

Calendar, Gmail, Drive, Docs, and more.

### Recommended: gogcli (CLI)

- **Website:** [gogcli.sh](https://gogcli.sh/)
- **Repo:** [steipete/gogcli](https://github.com/steipete/gogcli)
- **Services:** Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, Slides, People, Chat, Forms, Keep
- **Install:** `brew install gogcli`
- **Auth:** Google Cloud OAuth client JSON, then `gog auth add you@gmail.com`
- **Why:** More token-efficient than MCP (MCP tool schemas eat 37k-98k tokens just loading). CLI only needs a small command reference. Covers ALL Google services in one tool.

### Alternative: Google Workspace MCP

- **Repo:** [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
- **Services:** Gmail, Calendar, Docs, Sheets, Slides, Chat, Forms, Tasks, Contacts, Drive, Search
- **Auth:** Google Desktop OAuth 2.1
- **Why:** If you prefer MCP protocol over CLI. Multi-user support.

### Calendar-Only MCP

- **Repo:** [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) (~1,000 stars)
- **Features:** List/create/update/delete events, free/busy, multi-account, recurring events
- **Setup:** `npx @cocal/google-calendar-mcp` with OAuth credentials
- **Why:** Most mature calendar-specific option if you only need calendar

### Notion

- **Repo:** [makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server) (Official)
- **Features:** Page CRUD, database queries, block operations, comments
- **Auth:** Notion Internal Integration Token
- **Setup:** `npx -y @notionhq/notion-mcp-server`
- **Note:** Notion is prioritizing their remote MCP at `https://mcp.notion.com/mcp` -- local server may be sunset

### Weather

- **Repo:** [jezweb/weather-mcp-server](https://github.com/jezweb/weather-mcp-server)
- **Auth:** OpenWeatherMap API key (free tier available)
- **Features:** Current weather, forecasts, air quality

**No-API-Key Option:**
- **Repo:** [isdaniel/mcp_weather_server](https://github.com/isdaniel/mcp_weather_server)
- **Uses:** Open-Meteo API (free, no key)

### Security — Google Workspace

| Concern | Mitigation |
|---------|------------|
| **Who can use** | **Owner-only. This is critical.** Google Workspace access means reading emails, calendar events, Drive files -- extremely sensitive personal data. Never expose to non-owner Discord users. |
| **Scope / permissions** | Use minimal OAuth scopes. Calendar read-only if you only need to check schedule. Don't grant Gmail send permission unless explicitly needed. Review scopes in GCP console. |
| **OAuth token storage** | gogcli stores tokens locally. Ensure `~/.config/gogcli/` has restrictive file permissions (700). Never commit tokens to git. |
| **Data leakage** | Calendar events, email subjects, and Drive filenames may contain sensitive info. Never forward Google Workspace data to public Discord channels. DM-only for any Google data responses. |
| **Action scope** | Start with read-only operations. Creating/deleting calendar events, sending emails, modifying Drive files should require explicit confirmation. |
| **Multi-account** | If multiple Google accounts are configured, ensure the bot uses the intended account. Set a default with `gog auth manage`. |

### Security — Notion

| Concern | Mitigation |
|---------|------------|
| **Who can use** | Owner-only. Notion contains personal/work data. |
| **Scope** | Internal Integration Token only has access to pages/databases explicitly shared with it. Share only what's needed -- don't give it access to entire workspace. |
| **Data leakage** | Same as Google -- Notion page content may be sensitive. Respond in DMs only, never public channels. |
| **Write operations** | Creating/updating/deleting pages should require confirmation or be owner-only. |

### Security — Weather

| Concern | Mitigation |
|---------|------------|
| **Who can use** | Safe for all users. Weather data is public information. |
| **Location privacy** | Users requesting weather for specific addresses may reveal personal location. Don't log or store location queries in memory. Use city-level granularity, not street addresses. |
| **API abuse** | OpenWeatherMap free tier has rate limits. Open-Meteo is more generous but still has limits. Rate limit requests per user. |

---

## Priority & Implementation Order

Based on fun factor, usefulness, and setup complexity:

| Priority | Integration | Fun | Useful | Complexity | Cost |
|----------|------------|-----|--------|------------|------|
| 1 | Image Generation (Flux) | High | Medium | Low | Free |
| 2 | Voice (TTS/STT) | High | Medium | High | Free-$$ |
| 3 | YouTube (yt-dlp) | High | Medium | Low | Free |
| 4 | Google Workspace (gogcli) | Low | High | Medium | Free |
| 5 | Weather | Low | Medium | Low | Free |
| 6 | Notion | Low | Medium | Low | Free |

### Quick Wins (< 1 hour setup)
- Image gen via MCPollinations (zero config)
- YouTube transcripts (zero config)
- Weather via Open-Meteo (zero config)

### Medium Effort (1-4 hours)
- Image gen via Together AI Flux (API key setup)
- YouTube full via yt-dlp (install yt-dlp)
- Google Workspace via gogcli (OAuth setup)
- Notion (API token setup)

### Major Effort (1-2 days)
- Voice channels (discord.js voice deps + TTS/STT pipeline)
- Voice messages (OGG/Opus encoding pipeline)

---

## Architecture Notes

### Adding MCP Servers to Choomfie

Since Choomfie runs as a Claude Code Channels plugin, external MCP servers are configured in the Claude Code session's `.mcp.json` or project settings -- not inside Choomfie itself. Claude Code natively supports multiple MCP servers simultaneously.

```json
{
  "mcpServers": {
    "choomfie": { "command": "bun", "args": ["server.ts"] },
    "image-gen": { "command": "npx", "args": ["together-mcp@latest"] },
    "youtube": { "command": "npx", "args": ["-y", "@kevinwatt/yt-dlp-mcp@latest"] }
  }
}
```

Claude sees all tools from all servers and decides which to call per message. No custom orchestration needed.

### CLI Tools (gogcli)

CLI tools are invoked via Claude Code's Bash tool, not MCP. This is actually more token-efficient -- no tool schema loading overhead. Just needs a skill or CLAUDE.md reference for the command syntax.
