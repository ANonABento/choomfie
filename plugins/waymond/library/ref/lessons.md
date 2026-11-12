# Editing lessons/<mode>.md
Row: `date | mode: trigger | what went wrong | rule now | src:<PR/issue/url> | hits:<n>`
Regex: `^\d{4}-\d{2}-\d{2} \| [a-z0-9]+: [^|]+ \| [^|]+ \| [^|]+ \| src:[^|]+ \| hits:\d+$`
1. Cap 2,200 chars per file (excluding header). Over 80% → consolidate first.
2. Same lesson again → bump hits + date, no duplicate row.
3. hits ≥ 3 → promote `rule now` into core/<mode>.md, delete row.
4. Drop rows > 90 days old with hits:1.
5. Don't record what can be rediscovered from code, docs or web.
Thresholds in 3–4 are own design, untested. Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory

When adding to the library: tag every value/snippet `tested` (ran it here or on the user's gear) or `untested`.
