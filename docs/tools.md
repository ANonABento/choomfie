# Tool Reference

Every MCP tool Choomfie exposes, and the behaviour behind the richer ones.
Tool lists are dynamic — the supervisor always exposes `restart`, the worker
exposes the core set, and enabled plugins add their own.

See [CLAUDE.md](../CLAUDE.md) for the architecture these run inside.

## Tools (98 with every plugin enabled, 99 with pipelines)

Tool lists are dynamic: the supervisor always exposes `restart`, the worker exposes 35 core tools (36 when `pipelines` is configured), and enabled plugins add their own. With all shipped plugins enabled (voice 3, browser 7, tutor 19, socials 33 = 62), Choomfie exposes 98 MCP tools total (99 with pipelines): 97 worker tools plus the supervisor-owned `restart` tool.

Core Discord: reply (with embeds), react, edit_message, fetch_messages, search_messages, create_thread, create_poll, pin_message, unpin_message
Core Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Core Personas: switch_persona, save_persona, list_personas, delete_persona
Core Reminders: set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder
Core Birthdays: birthday_add, birthday_remove, birthday_list, birthday_upcoming
Core Access: allow_user, remove_user, list_allowed_users (owner only)
Core GitHub: check_github
Core Status: choomfie_status
Core Translation: translate
Core Brains: ask_brain (owner only)
Core Pipelines: pipeline (owner only; only when `pipelines` is configured)
System: restart (owner only, supervisor-owned — kills worker, spawns fresh one, reloads all code)

Browser plugin: browse, browser_click, browser_type, browser_screenshot, browser_eval, browser_press_key, browser_close
Voice plugin: join_voice, leave_voice, speak
Tutor plugin: tutor_prompt, dictionary_lookup, quiz, set_level, list_modules, switch_module, srs_review, srs_rate, srs_stats, srs_reminders, lesson_status, random_word, convert_kana, kanji_stroke_info, convert_pinyin, stroke_info, convert_hanzi
Socials plugin: youtube_search, youtube_info, youtube_transcript, youtube_auth, youtube_comment, reddit_search, reddit_posts, reddit_comments, reddit_auth, reddit_post, reddit_comment, linkedin_auth, linkedin_post, linkedin_post_image, linkedin_post_images, linkedin_post_link, linkedin_edit, linkedin_poll, linkedin_repost, linkedin_delete, linkedin_comments, linkedin_comment, linkedin_react, linkedin_schedule, linkedin_queue, linkedin_monitor, linkedin_analytics, linkedin_status, twitter_auth, twitter_post, twitter_post_image, twitter_thread, twitter_status

### ask_brain
Claude hands a job to another brain and reads the answer itself: `ask_brain(brain, prompt, chat_id, conversation?, files?, save_to?)`. Made for what only that brain can do, such as Waymond's image generation, used from a Claude chat (a design brainstorm, a local tool that needs pictures). The tool is a thin face over `askBrain()` (`lib/ask-brain.ts`), which other callers can use too.
- **Same conversation as a `/brain` channel:** one per (chat, brain), its status line there while it works, and the same queue (a message typed in that thread waits for the ask, and the other way round). `conversation` continues another chat's, such as the thread where the owner designed something with Waymond, so it keeps that context; the default is `chat_id`.
- **Background work is waited for:** if the brain moves the turn to the background, the call waits for each late result (up to 48 min in all; the worker allows this tool 50, other tools 2). What lands after that is posted in the conversation as usual.
- **Files** it hands back are written to `save_to` (absolute) or `<data dir>/brain-files/<brain>/<time>/`, names reduced to a plain file name, and their paths are returned with the text.
- **Owner only, in code:** the call is refused unless the latest message handed to Claude in the caller's chat came from the owner (`callerIsOwner`, `lib/caller.ts`). A daemon session is judged by its own chat (its endpoint token is bound to it), not by the `chat_id` it passes. It's also off the `role="user"` allowlist.
- **Which brains:** any loaded brain except Claude. Claude as a target would let a caller start a session that runs commands; it stays off until there's a use and limits to go with it.

### Pipelines (pipeline)
Run a local command-line tool on this machine for a chat, from any brain: Claude in a session, or Waymond over the remote endpoint (when `pipeline` is on `remoteMcp.tools`). One tool with an `action` (`run`, `status`, `stop`), since every tool's name is listed in every session. A brain learns what a pipeline is for only in a thread put on it with `/pipeline <name>` (once per chat; see `docs/commands.md`), so other chats pay nothing for it. Pipelines are declared by hand in config.json (see `docs/configuration.md`); code in `lib/pipelines/`.
- **`run` (`pipeline`, `args`, `chat_id`, `files?`)**: `args` is a list, run without a shell, whose first item must be on the pipeline's `allow` list. A path argument (absolute, `~`, or with `..`) must stay inside the pipeline's folder or the job's files folder.
- **Inline or background:** a command that ends within 20 s answers with its JSON result. A longer one becomes a job, one at a time per pipeline with the rest queued; when it ends, its line (✅/❌, how long) and its pictures are posted in `chat_id`, and a note goes on that chat's next message to its brain (`lib/chat-notes.ts`), so nothing polls.
- **Results are posted for a remote brain:** a call from the remote endpoint (Waymond) always posts its line (✅/❌) and `next.say` in the chat, even inline with no pictures. Waymond's turn ends at its approval prompt, so it never relays the result itself; Claude does, so its quick results aren't posted twice.
- **Pictures are posted for the brain:** every picture in the result's `show` and `next.show` is posted to the chat once (again only if it changes). Waymond can't attach a file from this machine; Claude needn't repeat it.
- **Pictures from the chat:** `files` (`"last_reply"`, the images in the brain's latest reply; `"last_mine"`, the user's latest; or message ids) are copied into a folder that replaces `{files}` in `args`. Images posted in a chat are kept for 7 days for this (`<data dir>/thread-files/`).
- **Result contract** (a pipeline with `json`): one JSON object on stdout, `{ok, show?: [paths], next?: {say, show, waiting}, problem?}`; progress on stderr, which goes to `<data dir>/pipeline-logs/<pipeline>/<job>.log`.
- **`status`** lists the pipelines and recent jobs, or one job (`job_id`) with its result and log end; **`stop`** stops a queued or running job. Jobs are kept in memory: a restart forgets them and stops running ones.
- **Owner only, in code** (`callerIsOwner`), like `ask_brain`.
- **Hints:** marked as changing things but not destructive (MCP `annotations`), so a client like Ambition asks once per call, not twice. The read tools on the remote allowlist are marked read-only (`READ_ONLY` in `lib/ipc-types.ts`).

### Rich Embeds

The `reply` tool supports Discord embeds via the `embeds` parameter. Each embed takes:
- `title`, `description`, `color` (name: blue/green/yellow/orange/red/purple/pink/grey, or hex)
- `fields` array of `{name, value, inline?}`
- `footer`, `thumbnail`, `url`

Use for structured content (status, lists, summaries). Plain text for casual chat.

### Polls

`create_poll` creates Discord native polls:
- 2-10 options, 1-168 hour duration (default 24)
- Optional multi-select
- Uses Discord's built-in poll UI (not reaction-based)

### Reminder System

Reminders use precise `setTimeout` timers — each reminder gets its own timer that fires exactly when due. No polling, zero wasted compute.

Architecture:
- `ReminderScheduler` class in `packages/core/lib/reminders.ts` manages all timers
- On startup: loads pending reminders from DB, sets a timer for each
- On create/snooze: immediately schedules a new timer
- On cancel/ack: clears the timer
- Nag mode: after firing, schedules a repeating nag timer

Features:
- **Recurring:** `cron` param supports "hourly", "daily", "weekly", "monthly", "every Xm/h/d"
- **Nag mode:** `nag_interval` (minutes) re-pings until user acknowledges via `ack_reminder`
- **Snooze:** `snooze_reminder` reschedules a fired reminder (non-recurring only; recurring auto-acks)
- **Categories:** optional label for grouping (e.g. "work", "personal")
- **History:** `list_reminders` with `include_history=true` shows fired reminders
- **Buttons:** reminder notifications include interactive buttons (Done, Snooze 30m/1h/Tomorrow) — no Claude roundtrip needed, handled directly by `packages/core/lib/interactions.ts`

**Datetime format:** All dates stored in SQLite use space-separated format (`YYYY-MM-DD HH:MM:SS`), never ISO 8601 with `T`/`Z`. Use `@choomfie/shared` time utilities (`toSQLiteDatetime`, `dateToSQLite`, `nowUTC`) for all conversions.

DB schema (auto-migrated):
```sql
reminders: id, user_id, chat_id, message, due_at, fired, created_at,
           cron, nag_interval, category, ack, last_nag_at
```
