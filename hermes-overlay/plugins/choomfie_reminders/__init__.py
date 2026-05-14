from .tools import (
    choomfie_reminder_ack,
    choomfie_reminder_cancel,
    choomfie_reminder_create,
    choomfie_reminder_list,
    choomfie_reminder_plan,
    choomfie_reminder_snooze,
)


PLAN_SCHEMA = {
    "name": "choomfie_reminder_plan",
    "description": "Preview how a Choomfie reminder request maps to Hermes cron/delivery fields.",
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
            "schedule": {"type": "string"},
            "timezone": {"type": "string"},
            "delivery": {"type": "string", "description": "origin, dm, local, all, or discord:<channel_id>[:thread_id]"},
            "nag": {"type": "boolean"},
            "ack_required": {"type": "boolean"},
        },
        "required": ["message", "schedule"],
    },
}

CREATE_SCHEMA = {
    "name": "choomfie_reminder_create",
    "description": "Create a Choomfie reminder backed by a Hermes cron job and profile-local numeric id.",
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
            "schedule": {
                "type": "string",
                "description": "30m, in 30 minutes, tomorrow at 9am, ISO timestamp, daily at 9am, weekly on monday at 9am, monthly on day 1 at 9am, or every 2h",
            },
            "timezone": {"type": "string", "description": "IANA timezone, defaults to America/Toronto/profile TZ"},
            "delivery": {"type": "string", "description": "origin, local, all, or explicit discord:<channel_id>[:thread_id]"},
            "ack_required": {"type": "boolean"},
            "nag": {"type": "boolean"},
            "nag_interval": {"type": "string", "description": "Optional nag interval metadata, for example 30m"},
        },
        "required": ["message", "schedule"],
    },
}

LIST_SCHEMA = {
    "name": "choomfie_reminder_list",
    "description": "List active Choomfie reminders and their mapped Hermes cron job ids.",
    "parameters": {
        "type": "object",
        "properties": {
            "include_history": {"type": "boolean"},
            "include_cron": {"type": "boolean"},
        },
    },
}

CANCEL_SCHEMA = {
    "name": "choomfie_reminder_cancel",
    "description": "Cancel a Choomfie reminder by numeric id and remove its Hermes cron jobs.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "reminder_id": {"type": "integer"},
        },
    },
}

SNOOZE_SCHEMA = {
    "name": "choomfie_reminder_snooze",
    "description": "Snooze a Choomfie reminder by creating a new one-shot Hermes cron job.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "reminder_id": {"type": "integer"},
            "duration": {"type": "string", "description": "30m, 1h, tomorrow, or another one-shot schedule"},
            "schedule": {"type": "string"},
        },
    },
}

ACK_SCHEMA = {
    "name": "choomfie_reminder_ack",
    "description": "Acknowledge a Choomfie reminder and remove any tracked nag job.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "reminder_id": {"type": "integer"},
        },
    },
}


def _with_ctx(ctx, handler):
    return lambda args=None, **kwargs: handler(args or {}, ctx=ctx, **kwargs)


def register(ctx):
    tool_defs = [
        (PLAN_SCHEMA, choomfie_reminder_plan, "Preview Choomfie reminder normalization."),
        (CREATE_SCHEMA, choomfie_reminder_create, "Create Choomfie reminders on Hermes cron."),
        (LIST_SCHEMA, choomfie_reminder_list, "List Choomfie reminder ids and Hermes cron mapping."),
        (CANCEL_SCHEMA, choomfie_reminder_cancel, "Cancel Choomfie reminders by numeric id."),
        (SNOOZE_SCHEMA, choomfie_reminder_snooze, "Snooze Choomfie reminders using one-shot Hermes cron."),
        (ACK_SCHEMA, choomfie_reminder_ack, "Acknowledge Choomfie reminders and stop tracked nag state."),
    ]
    for schema, handler, description in tool_defs:
        ctx.register_tool(
            schema["name"],
            "choomfie",
            schema,
            _with_ctx(ctx, handler),
            description=description,
        )
