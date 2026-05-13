import json


SUPPORTED = {"spanish", "japanese", "french", "chinese"}


def choomfie_tutor_session(args=None, **kwargs):
    args = args or {}
    language = str(args.get("language", "")).lower()
    if language not in SUPPORTED:
        return json.dumps({"error": "Unsupported language", "supported": sorted(SUPPORTED)})

    mode = args.get("mode", "resume")
    return json.dumps(
        {
            "language": language,
            "level": args.get("level") or "active profile level",
            "mode": mode,
            "flow": ["prompt", "quiz", "correction", "retry", "progress update"],
            "state": "Store active module, level, last quiz, and progress in Hermes profile state.",
            "claude_code_mode_data": "Preserve Choomfie tutor data; use Claude Code mode modules as source material during migration.",
        }
    )
