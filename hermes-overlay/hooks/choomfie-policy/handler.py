async def handle(event_type, context):
    if event_type == "gateway:startup":
        print("[choomfie] Hermes gateway starting with Choomfie overlay", flush=True)
    elif event_type.startswith("command:"):
        command = event_type.split(":", 1)[1]
        if command in {"voice", "lesson", "memory", "persona"}:
            print(f"[choomfie] command routed through migration surface: {command}", flush=True)
