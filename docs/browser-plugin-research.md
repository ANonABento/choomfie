# Browser Plugin — Research

Headless browser plugin for Choomfie. Goal: give the bot browser access for web automation, screenshots, auth, scraping, and testing.

## Top 3 Options

### 1. Playwright (Direct) — Pragmatic Choice

**What:** Microsoft's browser automation library. Industry standard. Already available as MCP server in our setup.
**Stars:** ~78k | **License:** Apache-2.0 | **Cost:** Free

- TypeScript-native, works with Bun (basic operations confirmed)
- Screenshots via `page.screenshot()` → Buffer → Discord upload
- Session persistence via `storageState()` (cookies + localStorage to JSON)
- Persistent contexts via `launchPersistentContext(userDataDir)` for full profile
- Anti-bot: basic stealth via `playwright-extra`, new headless mode (full Chrome)
- **Con:** No AI understanding of pages — relies on selectors or Claude reasoning from screenshots

### 2. Stagehand — AI-Native Choice

**What:** TypeScript library by Browserbase that adds AI actions on top of Playwright.
**Stars:** ~21.7k | **License:** MIT | **Cost:** Free (+ LLM API cost per AI action)
**Repo:** github.com/browserbase/stagehand

Three APIs:
- `act("click the login button")` — natural language actions, self-healing selectors
- `extract("get all product prices")` — structured data extraction with schema
- `observe("find all interactive elements")` — page understanding

- Built on Playwright — all Playwright APIs still available
- Can run locally (no Browserbase cloud needed), just needs LLM API key
- Auto-caching: remembers successful actions, skips LLM on repeat
- **Con:** Adds LLM cost per AI action, slightly slower

### 3. Hybrid (Recommended) — Playwright + Stagehand

Use Playwright for deterministic operations (navigate, screenshot, known selectors) and Stagehand for AI-powered operations (unknown pages, natural language, extraction).

Claude chooses: fast Playwright tools for known workflows, Stagehand AI tools for unfamiliar pages.

## Eliminated Options

| Tool | Why Eliminated |
|------|---------------|
| Selenium | Legacy, slower, no advantages over Playwright |
| browser-use (Python) | Python-only, would need subprocess |
| browser-use (TS port) | 11 stars, stale since Jan 2025 |
| LaVague | Python-only, stalled since Jan 2025 |
| Dendrite | Explicitly abandoned |
| Multion | Cloud-only paid API |
| Browserbase | Cloud infrastructure, not a local tool |
| Skyvern | Python server, TS SDK is thin cloud client |
| Steel | Requires Docker, overkill for single bot |
| AgentQL | Requires API key, 300 free calls then paid |

## Architecture

```
plugins/browser/
  index.ts          # Plugin entry — registers tools, manages browser lifecycle
  browser.ts        # Singleton browser manager (launch, persistent context, sessions)
  tools.ts          # MCP tool definitions:
                    #   browse_url      — navigate + screenshot (Playwright)
                    #   click_element   — CSS/XPath selector click (Playwright)
                    #   fill_form       — fill known fields (Playwright)
                    #   ai_act          — natural language action (Stagehand)
                    #   ai_extract      — structured data extraction (Stagehand)
                    #   ai_observe      — find interactive elements (Stagehand)
                    #   take_screenshot — capture + upload to Discord (Playwright)
                    #   save_session    — persist auth cookies (Playwright)
                    #   load_session    — restore auth cookies (Playwright)
  sessions.ts       # Session persistence (storageState save/load)
```

## Session Persistence

Critical for auth across restarts:

1. **storageState()** — Save cookies + localStorage to `~/.claude/plugins/data/choomfie-inline/browser/sessions/{name}.json`
2. **Persistent context** — Full browser profile in `browser/profiles/{name}/`
3. **Named sessions** — `save_session("twitter")` / `load_session("twitter")`

## Use Cases

- **Social media auth** — Log into Twitter/LinkedIn/Instagram via browser, persist session. No API keys needed.
- **Web app testing** — "Check if the login page works" → navigate, fill form, screenshot result
- **Screenshot capture** — Take screenshots of any URL, upload to Discord
- **Content scraping** — Read articles, docs, dashboards without APIs
- **Form automation** — Fill out forms, submit applications
- **Monitoring** — Check deployment status, dashboard metrics, service health

## Bun Compatibility

- `bun add playwright` works
- `bunx playwright install chromium` for browser binary
- Single-page automation (navigate, click, screenshot) works on Bun
- Test runner with workers can hang (not relevant — we're not running tests)
- If issues arise, can spawn browser subprocess with Node as fallback

## Packages

```bash
bun add playwright @browserbasehq/stagehand
bunx playwright install chromium
```

## Anti-Bot

- `playwright-extra` + stealth plugin for basic detection bypass
- New headless mode (full Chrome binary) for better fingerprint
- For Cloudflare/DataDome: need headed mode or residential proxy (inherent limitation)
- Stagehand's vision approach can sometimes work better against dynamic anti-bot

## What Top AI Agents Use

Every major AI coding agent builds on Playwright:

| Agent | Browser Tool | Notes |
|-------|-------------|-------|
| **Devin** | Built-in Chromium | Full sandbox in cloud VM |
| **OpenHands** | BrowserGym + Playwright | Screenshots + accessibility tree |
| **Kilo Code** | Puppeteer-based | Headless browser with screenshots |
| **Claude Code** | Playwright MCP | What we already have |
| **Cursor** | None | No browser integration |
| **SWE-Agent** | None | Terminal only |

**Conclusion:** Playwright is the universal engine. The innovation is in AI abstraction layers on top (browser-use for Python, Stagehand for TypeScript).

## Evaluated & Skipped

- **Agent-Reach** (github.com/Panniantong/Agent-Reach) — Python web content extractor. Strips ads/nav, returns clean text for LLMs. Simpler than what we need — our WebFetch already does this, and Playwright + Readability.js would be strictly better (handles JS-rendered pages).
- **browser-use** (74k stars) — Most popular AI browser agent, but Python-only. Stagehand is the TS equivalent.
- **Dia browser** (Browser Company) — AI-native consumer browser, not open source, not for agents.
- **Arc** — Consumer browser with AI features, not agent-focused.

## Features to Include

1. **Core browser** — launch, navigate, screenshot, session persistence
2. **Reader mode** — strip page junk (ads, nav, scripts), return clean article text. Use Readability.js or similar extraction on Playwright page content.
3. **Discord integration** — screenshot upload, embed previews
4. **Stagehand AI actions** — natural language control for unknown pages
5. **Social media auth** — browser-based login for socials plugin (bypasses API costs)
6. **Monitoring/automation** — scheduled checks, alerts
