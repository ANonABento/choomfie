import json


def choomfie_reminder_plan(args=None, **kwargs):
    args = args or {}
    return json.dumps(
        {
            "message": args.get("message", ""),
            "schedule": args.get("schedule", ""),
            "timezone": args.get("timezone") or "profile default",
            "targets": [args.get("delivery") or "origin"],
            "ack_required": True,
            "snooze_supported": True,
            "nag_mode": bool(args.get("nag")),
            "implementation": "Create/update a Hermes cron job and route output through Hermes delivery. Do not start the Claude Code mode Choomfie scheduler for Hermes reminders.",
        }
    )
