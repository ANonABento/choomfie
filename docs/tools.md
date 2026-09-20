# Tool Reference

Every MCP tool Choomfie exposes, and the behaviour behind the richer ones.
Tool lists are dynamic — the supervisor always exposes `restart`, the worker
exposes the core set, and enabled plugins add their own.

See [CLAUDE.md](../CLAUDE.md) for the architecture these run inside.

## Tools (97 with every plugin enabled)

Tool lists are dynamic: the supervisor always exposes `restart`, the worker exposes 34 core tools, and enabled plugins add their own. With all shipped plugins enabled (voice 3, browser 7, tutor 19, socials 33 = 62), Choomfie exposes 97 MCP tools total: 96 worker tools plus the supervisor-owned `restart` tool.

Core Discord: reply (with embeds), react, edit_message, fetch_messages, search_messages, create_thread, create_poll, pin_message, unpin_message
Core Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Core Personas: switch_persona, save_persona, list_personas, delete_persona
Core Reminders: set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder
Core Birthdays: birthday_add, birthday_remove, birthday_list, birthday_upcoming
Core Access: allow_user, remove_user, list_allowed_users (owner only)
Core GitHub: check_github
Core Status: choomfie_status
Core Translation: translate
System: restart (owner only, supervisor-owned — kills worker, spawns fresh one, reloads all code)

Browser plugin: browse, browser_click, browser_type, browser_screenshot, browser_eval, browser_press_key, browser_close
Voice plugin: join_voice, leave_voice, speak
Tutor plugin: tutor_prompt, dictionary_lookup, quiz, set_level, list_modules, switch_module, srs_review, srs_rate, srs_stats, srs_reminders, lesson_status, random_word, convert_kana, kanji_stroke_info, convert_pinyin, stroke_info, convert_hanzi
Socials plugin: youtube_search, youtube_info, youtube_transcript, youtube_auth, youtube_comment, reddit_search, reddit_posts, reddit_comments, reddit_auth, reddit_post, reddit_comment, linkedin_auth, linkedin_post, linkedin_post_image, linkedin_post_images, linkedin_post_link, linkedin_edit, linkedin_poll, linkedin_repost, linkedin_delete, linkedin_comments, linkedin_comment, linkedin_react, linkedin_schedule, linkedin_queue, linkedin_monitor, linkedin_analytics, linkedin_status, twitter_auth, twitter_post, twitter_post_image, twitter_thread, twitter_status

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
