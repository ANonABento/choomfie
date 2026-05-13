from .tools import choomfie_reminder_plan


SCHEMA = {
    "name": "choomfie_reminder_plan",
    "description": "Normalize a Choomfie reminder request into Hermes cron/delivery fields.",
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
            "schedule": {"type": "string"},
            "timezone": {"type": "string"},
            "delivery": {"type": "string", "description": "origin, dm, or discord:<channel_id>"},
            "nag": {"type": "boolean"},
        },
        "required": ["message", "schedule"],
    },
}


def register(ctx):
    ctx.register_tool(
        "choomfie_reminder_plan",
        "choomfie",
        SCHEMA,
        choomfie_reminder_plan,
        description="Normalize Choomfie reminders onto Hermes cron/delivery.",
    )
