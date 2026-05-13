from .tools import choomfie_help, choomfie_status


STATUS_SCHEMA = {
    "name": "choomfie_status",
    "description": "Report Choomfie's Hermes migration status and Claude Code mode command.",
    "parameters": {"type": "object", "properties": {}},
}

HELP_SCHEMA = {
    "name": "choomfie_help",
    "description": "Show the Choomfie command surfaces available on Hermes and Claude Code mode.",
    "parameters": {"type": "object", "properties": {}},
}


def register(ctx):
    ctx.register_tool(
        "choomfie_status",
        "choomfie",
        STATUS_SCHEMA,
        choomfie_status,
        description="Report Choomfie's Hermes migration status.",
    )
    ctx.register_tool(
        "choomfie_help",
        "choomfie",
        HELP_SCHEMA,
        choomfie_help,
        description="Show Choomfie command surfaces and migration notes.",
    )

    def pre_gateway_dispatch(**kwargs):
        event = kwargs.get("event")
        text = getattr(event, "text", "") if event is not None else ""
        if text.strip().lower() in {"/status", "/help"}:
            return {"action": "allow"}
        return None

    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
