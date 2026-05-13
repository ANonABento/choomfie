from .tools import choomfie_tutor_session


SCHEMA = {
    "name": "choomfie_tutor_session",
    "description": "Start or resume a Choomfie tutor session for Spanish, Japanese, French, or Chinese.",
    "parameters": {
        "type": "object",
        "properties": {
            "language": {"type": "string", "enum": ["spanish", "japanese", "french", "chinese"]},
            "level": {"type": "string"},
            "mode": {"type": "string", "enum": ["start", "resume", "quiz", "correct", "retry"]},
            "answer": {"type": "string"},
        },
        "required": ["language", "mode"],
    },
}


def register(ctx):
    ctx.register_tool(
        "choomfie_tutor_session",
        "choomfie",
        SCHEMA,
        choomfie_tutor_session,
        description="Start or resume a Choomfie tutor session.",
    )
