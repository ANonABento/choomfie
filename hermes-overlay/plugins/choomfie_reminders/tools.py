import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


STATE_VERSION = 1
STATE_FILE = "choomfie-reminders.json"
DEFAULT_TIMEZONE = "America/Toronto"
COMMON_SNOOZES = {
    "30m": "30m",
    "30 minutes": "30m",
    "1h": "1h",
    "1 hour": "1h",
}


def _json(data):
    return json.dumps(data, indent=2, sort_keys=True)


def _now():
    return datetime.now(timezone.utc)


def _utc_iso(dt=None):
    return (dt or _now()).astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _profile_home():
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or "~/.choomfie-hermes/profiles/choomfie").expanduser()


def _state_path():
    return _profile_home() / "state" / STATE_FILE


def _script_relative_path(reminder_id):
    return f"choomfie-reminders/reminder-{int(reminder_id)}.py"


def _write_reminder_script(reminder_id, message):
    rel_path = _script_relative_path(reminder_id)
    script_path = _profile_home() / "scripts" / rel_path
    script_path.parent.mkdir(parents=True, exist_ok=True)
    output = f"Reminder: {message}"
    script_path.write_text(f"print({json.dumps(output, ensure_ascii=False)})\n")
    return rel_path


def _remove_reminder_script(record):
    rel_path = str(record.get("script") or "")
    if not rel_path:
        return
    scripts_dir = (_profile_home() / "scripts").resolve()
    script_path = (scripts_dir / rel_path).resolve()
    try:
        script_path.relative_to(scripts_dir)
    except ValueError:
        return
    try:
        script_path.unlink()
    except FileNotFoundError:
        pass


def _empty_state():
    return {"version": STATE_VERSION, "next_id": 1, "reminders": []}


def _load_state():
    path = _state_path()
    if not path.exists():
        return _empty_state()
    try:
        state = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return _empty_state()
    if state.get("version") != STATE_VERSION or not isinstance(state.get("reminders"), list):
        return _empty_state()
    state.setdefault("next_id", 1)
    return state


def _save_state(state):
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(_json(state) + "\n")
    tmp.replace(path)


def _as_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _normalize_timezone(value):
    tz_name = str(value or "").strip() or os.environ.get("TZ") or DEFAULT_TIMEZONE
    try:
        return tz_name, ZoneInfo(tz_name), None
    except ZoneInfoNotFoundError:
        return tz_name, None, f"Invalid timezone '{tz_name}'. Use an IANA timezone like America/Toronto."


def _parse_time(text, tz):
    value = text.strip().lower().replace(".", "")
    match = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", value)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    meridiem = match.group(3)
    if meridiem == "pm" and hour != 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    now = datetime.now(tz)
    return now.replace(hour=hour, minute=minute, second=0, microsecond=0)


def _iso_from_local(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _normalize_schedule(schedule, timezone_name=None):
    raw = str(schedule or "").strip()
    if not raw:
        return None, None, None, "Schedule is required."

    tz_name, tz, tz_error = _normalize_timezone(timezone_name)
    if tz_error:
        return None, None, tz_name, tz_error

    lowered = re.sub(r"\s+", " ", raw.lower())
    profile_tz_name = os.environ.get("TZ") or DEFAULT_TIMEZONE

    if re.fullmatch(r"\d+[mhd]", lowered):
        return lowered, None, tz_name, None

    match = re.fullmatch(r"in (\d+)\s*(minute|minutes|min|mins|m|hour|hours|hr|hrs|h|day|days|d)", lowered)
    if match:
        unit = match.group(2)
        suffix = "m" if unit.startswith(("m", "min")) else "h" if unit.startswith(("h", "hr")) else "d"
        return f"{int(match.group(1))}{suffix}", None, tz_name, None

    if lowered.startswith("every "):
        every = lowered
        every = re.sub(r"\s+minutes?$", "m", every)
        every = re.sub(r"\s+mins?$", "m", every)
        every = re.sub(r"\s+hours?$", "h", every)
        every = re.sub(r"\s+hrs?$", "h", every)
        every = re.sub(r"\s+days?$", "d", every)
        if re.fullmatch(r"every \d+[mhd]", every):
            return every, every, tz_name, None
        return None, None, tz_name, "Use recurring intervals like 'every 2h' or 'every 30m'."

    daily_at = re.fullmatch(r"daily(?: at (.+))?", lowered)
    if daily_at:
        if tz_name != profile_tz_name:
            return None, None, tz_name, f"Named recurring reminders currently use the Choomfie profile timezone ({profile_tz_name}). Use that timezone or an interval like 'every 24h'."
        local_time = _parse_time(daily_at.group(1) or "9am", tz)
        if not local_time:
            return None, None, tz_name, "Could not parse daily time. Try 'daily at 9am'."
        return f"{local_time.minute} {local_time.hour} * * *", "daily", tz_name, None

    weekly_at = re.fullmatch(r"weekly(?: on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))?(?: at (.+))?", lowered)
    if weekly_at:
        if tz_name != profile_tz_name:
            return None, None, tz_name, f"Named recurring reminders currently use the Choomfie profile timezone ({profile_tz_name}). Use that timezone or an interval like 'every 7d'."
        local_time = _parse_time(weekly_at.group(2) or "9am", tz)
        if not local_time:
            return None, None, tz_name, "Could not parse weekly time. Try 'weekly on monday at 9am'."
        weekday = {
            "sunday": 0,
            "monday": 1,
            "tuesday": 2,
            "wednesday": 3,
            "thursday": 4,
            "friday": 5,
            "saturday": 6,
        }.get(weekly_at.group(1) or "monday")
        if weekday is None:
            return None, None, tz_name, "Could not parse weekly day. Try 'weekly on monday at 9am'."
        return f"{local_time.minute} {local_time.hour} * * {weekday}", "weekly", tz_name, None

    monthly_at = re.fullmatch(r"monthly(?: on(?: day)? (\d{1,2}))?(?: at (.+))?", lowered)
    if monthly_at:
        if tz_name != profile_tz_name:
            return None, None, tz_name, f"Named recurring reminders currently use the Choomfie profile timezone ({profile_tz_name}). Use that timezone or an interval like 'every 30d'."
        day = int(monthly_at.group(1) or 1)
        if day < 1 or day > 31:
            return None, None, tz_name, "Monthly day must be 1 through 31."
        local_time = _parse_time(monthly_at.group(2) or "9am", tz)
        if not local_time:
            return None, None, tz_name, "Could not parse monthly time. Try 'monthly on day 1 at 9am'."
        return f"{local_time.minute} {local_time.hour} {day} * *", "monthly", tz_name, None

    tomorrow_at = re.fullmatch(r"tomorrow(?: at (.+))?", lowered)
    if tomorrow_at:
        local_time = _parse_time(tomorrow_at.group(1) or "9am", tz)
        if not local_time:
            return None, None, tz_name, "Could not parse tomorrow time. Try 'tomorrow at 9am'."
        tomorrow = local_time + timedelta(days=1)
        return _iso_from_local(tomorrow), None, tz_name, None

    if "T" in raw or re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None, None, tz_name, f"Invalid ISO timestamp '{raw}'."
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=tz)
        return _iso_from_local(parsed), None, tz_name, None

    if re.fullmatch(r"[\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+", raw):
        return raw, "cron", tz_name, None

    return None, None, tz_name, "Unparseable schedule. Try '30m', 'in 30 minutes', 'tomorrow at 9am', 'daily at 9am', or 'every 2h'."


def _normalize_delivery(value):
    delivery = str(value or "").strip()
    if not delivery or delivery == "origin":
        return "origin", None
    if delivery in {"dm", "direct", "direct-message"}:
        return None, "DM delivery is not safely addressable by this overlay yet. Ask from the target DM conversation or pass an explicit Hermes delivery target."
    if delivery == "all" or delivery == "local" or delivery.startswith(("discord:", "telegram:", "sms:")):
        return delivery, None
    return None, "Delivery must be origin, dm, all, local, or an explicit target like discord:<channel_id>[:thread_id]."


def _cron_args_for_create(reminder_id, message, schedule, recurrence, delivery, script):
    payload = {
        "action": "create",
        "schedule": schedule,
        "name": f"choomfie-reminder-{reminder_id}",
        "script": script,
        "no_agent": True,
    }
    if delivery and delivery != "origin":
        payload["deliver"] = delivery
    if recurrence is None and not str(schedule).startswith("every ") and not re.fullmatch(r"[\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+ [\d\*\-,/]+", str(schedule)):
        payload["repeat"] = 1
    return payload


def _call_cron(ctx, args):
    if ctx is None or not hasattr(ctx, "dispatch_tool"):
        return None, "Hermes plugin context is unavailable; cannot call cronjob."
    raw = ctx.dispatch_tool("cronjob", args)
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None, f"cronjob returned a non-JSON response: {raw}"
    if not data.get("success"):
        return None, data.get("error") or data.get("message") or "cronjob failed"
    return data, None


def choomfie_reminder_plan(args=None, **kwargs):
    args = args or {}
    schedule, recurrence, timezone_name, error = _normalize_schedule(args.get("schedule"), args.get("timezone"))
    delivery, delivery_error = _normalize_delivery(args.get("delivery") or "origin")
    return _json(
        {
            "message": args.get("message", ""),
            "schedule": schedule or args.get("schedule", ""),
            "timezone": timezone_name,
            "delivery": delivery or args.get("delivery") or "origin",
            "recurrence": recurrence,
            "ack_required": _as_bool(args.get("ack_required"), True),
            "snooze_supported": True,
            "nag_mode": bool(args.get("nag") or args.get("nag_interval")),
            "error": error or delivery_error,
            "implementation": "Use choomfie_reminder_create/list/cancel/snooze/ack backed by Hermes cronjob and profile-local state.",
        }
    )


def choomfie_reminder_create(args=None, *, ctx=None, **kwargs):
    args = args or {}
    message = str(args.get("message") or "").strip()
    if not message:
        return _json({"success": False, "error": "message is required"})

    schedule, recurrence, timezone_name, error = _normalize_schedule(args.get("schedule"), args.get("timezone"))
    if error:
        return _json({"success": False, "error": error})

    delivery, delivery_error = _normalize_delivery(args.get("delivery") or "origin")
    if delivery_error:
        return _json({"success": False, "error": delivery_error})

    state = _load_state()
    reminder_id = int(state.get("next_id", 1))
    ack_required = _as_bool(args.get("ack_required"), True)
    nag_interval = args.get("nag_interval") or ("30m" if _as_bool(args.get("nag")) else None)
    script = _write_reminder_script(reminder_id, message)
    cron_payload = _cron_args_for_create(reminder_id, message, schedule, recurrence, delivery, script)
    cron_result, cron_error = _call_cron(ctx, cron_payload)
    if cron_error:
        _remove_reminder_script({"script": script})
        return _json({"success": False, "error": cron_error, "cronjob_args": cron_payload})

    job = cron_result.get("job") or {}
    record = {
        "id": reminder_id,
        "cron_job_id": cron_result.get("job_id"),
        "message": message,
        "script": script,
        "requested_schedule": str(args.get("schedule") or "").strip(),
        "schedule": schedule,
        "timezone": timezone_name,
        "delivery": delivery,
        "recurrence": recurrence,
        "nag_interval": nag_interval,
        "nag_job_id": None,
        "ack_required": ack_required,
        "acknowledged_at": None,
        "last_fired_at": None,
        "created_at": _utc_iso(),
        "next_run_at": cron_result.get("next_run_at") or job.get("next_run_at"),
        "state": "scheduled",
    }
    state["next_id"] = reminder_id + 1
    state["reminders"].append(record)
    _save_state(state)
    return _json({"success": True, "reminder": record, "message": f"Reminder {reminder_id} scheduled."})


def _visible_records(include_history=False):
    reminders = _load_state().get("reminders", [])
    if include_history:
        return reminders
    return [item for item in reminders if item.get("state") not in {"canceled", "acknowledged"}]


def _is_active_state(record):
    return record.get("state") not in {"canceled", "acknowledged", "fired", "snoozed"}


def _reconcile_fired_reminders(state, cron_jobs):
    changed = False
    active_job_ids = set(cron_jobs.keys())
    for record in state.get("reminders", []):
        if not _is_active_state(record):
            continue
        if record.get("recurrence"):
            continue
        cron_job_id = record.get("cron_job_id")
        if cron_job_id and cron_job_id not in active_job_ids:
            record["state"] = "fired"
            record["last_fired_at"] = _utc_iso()
            _remove_reminder_script(record)
            changed = True
    return changed


def choomfie_reminder_list(args=None, *, ctx=None, **kwargs):
    args = args or {}
    include_history = _as_bool(args.get("include_history"), False)
    state = _load_state()
    cron_jobs = None
    if _as_bool(args.get("include_cron"), True) and ctx is not None:
        cron_result, _ = _call_cron(ctx, {"action": "list", "include_disabled": include_history})
        if cron_result:
            cron_jobs = {job.get("job_id"): job for job in cron_result.get("jobs", [])}
            if _reconcile_fired_reminders(state, cron_jobs):
                _save_state(state)

    records = state.get("reminders", []) if include_history else [item for item in state.get("reminders", []) if _is_active_state(item)]

    reminders = []
    for record in records:
        item = dict(record)
        if cron_jobs is not None:
            job = cron_jobs.get(record.get("cron_job_id"))
            if job:
                item["next_run_at"] = job.get("next_run_at") or item.get("next_run_at")
                item["cron_state"] = job.get("state")
                item["enabled"] = job.get("enabled")
        reminders.append(item)
    return _json({"success": True, "count": len(reminders), "reminders": reminders})


def _find_record(state, reminder_id):
    try:
        wanted = int(reminder_id)
    except (TypeError, ValueError):
        return None
    for record in state.get("reminders", []):
        if int(record.get("id", -1)) == wanted:
            return record
    return None


def choomfie_reminder_cancel(args=None, *, ctx=None, **kwargs):
    args = args or {}
    reminder_id = args.get("id") or args.get("reminder_id")
    if reminder_id is None:
        return _json({"success": False, "error": "Reminder id is required. List reminders first if the id is unknown."})
    state = _load_state()
    record = _find_record(state, reminder_id)
    if not record:
        return _json({"success": False, "error": f"Reminder {reminder_id} was not found."})
    if record.get("state") == "canceled":
        return _json({"success": True, "reminder": record, "message": f"Reminder {record['id']} was already canceled."})

    removed_jobs = []
    for job_id in [record.get("cron_job_id"), record.get("nag_job_id")]:
        if job_id:
            cron_result, cron_error = _call_cron(ctx, {"action": "remove", "job_id": job_id})
            if cron_error and "not found" not in cron_error.lower():
                return _json({"success": False, "error": cron_error, "reminder": record})
            removed_jobs.append(job_id)

    record["state"] = "canceled"
    record["canceled_at"] = _utc_iso()
    _remove_reminder_script(record)
    _save_state(state)
    return _json({"success": True, "reminder": record, "removed_cron_job_ids": removed_jobs})


def _normalize_snooze_duration(value, timezone_name=None):
    raw = str(value or "30m").strip().lower()
    if raw in COMMON_SNOOZES:
        return COMMON_SNOOZES[raw], None
    if raw == "tomorrow":
        schedule, _, _, error = _normalize_schedule("tomorrow at 9am", timezone_name)
        return schedule, error
    schedule, recurrence, _, error = _normalize_schedule(raw, timezone_name)
    if recurrence:
        return None, "Snooze duration must be one-shot, for example 30m, 1h, or tomorrow."
    return schedule, error


def choomfie_reminder_snooze(args=None, *, ctx=None, **kwargs):
    args = args or {}
    reminder_id = args.get("id") or args.get("reminder_id")
    state = _load_state()
    record = _find_record(state, reminder_id)
    if not record:
        return _json({"success": False, "error": f"Reminder {reminder_id} was not found."})

    schedule, error = _normalize_snooze_duration(args.get("duration") or args.get("schedule"), record.get("timezone"))
    if error:
        return _json({"success": False, "error": error})

    new_id = int(state.get("next_id", 1))
    script = _write_reminder_script(new_id, record.get("message", ""))
    cron_payload = _cron_args_for_create(
        new_id,
        record.get("message", ""),
        schedule,
        None,
        record.get("delivery", "origin"),
        script,
    )
    cron_result, cron_error = _call_cron(ctx, cron_payload)
    if cron_error:
        _remove_reminder_script({"script": script})
        return _json({"success": False, "error": cron_error, "cronjob_args": cron_payload})

    for job_id in [record.get("cron_job_id"), record.get("nag_job_id")]:
        if job_id:
            _call_cron(ctx, {"action": "remove", "job_id": job_id})
    _remove_reminder_script(record)

    record["state"] = "snoozed"
    record["snoozed_at"] = _utc_iso()
    record["snoozed_to_id"] = new_id
    new_record = dict(record)
    new_record.update(
        {
            "id": new_id,
            "cron_job_id": cron_result.get("job_id"),
            "script": script,
            "requested_schedule": str(args.get("duration") or args.get("schedule") or "").strip() or "30m",
            "schedule": schedule,
            "recurrence": None,
            "nag_job_id": None,
            "acknowledged_at": None,
            "created_at": _utc_iso(),
            "next_run_at": cron_result.get("next_run_at"),
            "state": "scheduled",
        }
    )
    state["next_id"] = new_id + 1
    state["reminders"].append(new_record)
    _save_state(state)
    return _json({"success": True, "reminder": new_record, "snoozed_from_id": record["id"]})


def choomfie_reminder_ack(args=None, *, ctx=None, **kwargs):
    args = args or {}
    reminder_id = args.get("id") or args.get("reminder_id")
    state = _load_state()
    record = _find_record(state, reminder_id)
    if not record:
        return _json({"success": False, "error": f"Reminder {reminder_id} was not found."})
    if record.get("nag_job_id"):
        cron_result, cron_error = _call_cron(ctx, {"action": "remove", "job_id": record.get("nag_job_id")})
        if cron_error and "not found" not in cron_error.lower():
            return _json({"success": False, "error": cron_error, "reminder": record})
    record["acknowledged_at"] = _utc_iso()
    record["nag_job_id"] = None
    if not record.get("recurrence"):
        record["state"] = "acknowledged"
    _save_state(state)
    return _json({"success": True, "reminder": record, "message": f"Reminder {record['id']} acknowledged."})
