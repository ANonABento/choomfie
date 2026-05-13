import json


def choomfie_status(args=None, **kwargs):
    return json.dumps(
        {
            "runtime": "Hermes overlay",
            "claude_code_mode": "choomfie claude-code",
            "migration": {
                "discord_gateway": "Hermes-owned",
                "memory": "export/import tooling available; curated import required",
                "tutor": "skill/plugin vertical slice scaffolded",
                "reminders": "Hermes cron mapping scaffolded",
                "voice": "sidecar/deferred until manual parity evaluation",
            },
        }
    )


def choomfie_help(args=None, **kwargs):
    return json.dumps(
        {
            "commands": [
                "/status",
                "/help",
                "/memory",
                "/personality",
                "/lesson",
                "/voice",
                "/remind",
            ],
            "notes": [
                "Hermes owns gateway, sessions, approvals, provider routing, and delivery.",
                "Use /personality in Hermes mode; /persona is Claude Code mode only.",
                "Use choomfie claude-code for unported voice or Discord UX until parity is proven.",
            ],
        }
    )
