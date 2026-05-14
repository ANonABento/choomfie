import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


PLUGIN_PARENT = Path(__file__).resolve().parents[1] / "hermes-overlay" / "plugins"
sys.path.insert(0, str(PLUGIN_PARENT))

from choomfie_reminders import tools  # noqa: E402


class FakeCtx:
    def __init__(self):
        self.calls = []
        self.next_job = 1
        self.jobs = {}

    def dispatch_tool(self, tool_name, args):
        self.calls.append((tool_name, dict(args)))
        if tool_name != "cronjob":
            return json.dumps({"success": False, "error": "unexpected tool"})
        action = args.get("action")
        if action == "create":
            job_id = f"job-{self.next_job}"
            self.next_job += 1
            job = {
                "job_id": job_id,
                "name": args.get("name"),
                "schedule": args.get("schedule"),
                "next_run_at": "2026-05-13T17:00:00+00:00",
                "state": "scheduled",
                "enabled": True,
            }
            self.jobs[job_id] = job
            return json.dumps({"success": True, "job_id": job_id, "next_run_at": job["next_run_at"], "job": job})
        if action == "list":
            return json.dumps({"success": True, "count": len(self.jobs), "jobs": list(self.jobs.values())})
        if action == "remove":
            self.jobs.pop(args.get("job_id"), None)
            return json.dumps({"success": True, "removed_job": {"id": args.get("job_id")}})
        return json.dumps({"success": False, "error": f"bad action {action}"})


class ChoomfieReminderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = self.temp.name
        self.ctx = FakeCtx()

    def tearDown(self):
        if self.old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.old_home
        self.temp.cleanup()

    def load_state(self):
        return json.loads((Path(self.temp.name) / "state" / "choomfie-reminders.json").read_text())

    def test_create_list_cancel_maps_numeric_id_to_cron_job(self):
        created = json.loads(
            tools.choomfie_reminder_create(
                {"message": "check deploy", "schedule": "in 30 minutes", "timezone": "America/Toronto"},
                ctx=self.ctx,
            )
        )

        self.assertTrue(created["success"])
        self.assertEqual(created["reminder"]["id"], 1)
        self.assertEqual(created["reminder"]["cron_job_id"], "job-1")
        self.assertEqual(created["reminder"]["schedule"], "30m")
        self.assertEqual(self.ctx.calls[0][1]["action"], "create")
        self.assertEqual(self.ctx.calls[0][1]["repeat"], 1)
        self.assertEqual(self.ctx.calls[0][1]["no_agent"], True)
        self.assertEqual(self.ctx.calls[0][1]["script"], "choomfie-reminders/reminder-1.py")
        self.assertNotIn("skills", self.ctx.calls[0][1])
        self.assertNotIn("deliver", self.ctx.calls[0][1])
        self.assertTrue((Path(self.temp.name) / "scripts" / "choomfie-reminders" / "reminder-1.py").exists())

        listed = json.loads(tools.choomfie_reminder_list({}, ctx=self.ctx))
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["reminders"][0]["id"], 1)

        canceled = json.loads(tools.choomfie_reminder_cancel({"id": 1}, ctx=self.ctx))
        self.assertTrue(canceled["success"])
        self.assertEqual(canceled["reminder"]["state"], "canceled")
        self.assertEqual(canceled["removed_cron_job_ids"], ["job-1"])
        self.assertFalse((Path(self.temp.name) / "scripts" / "choomfie-reminders" / "reminder-1.py").exists())

        state = self.load_state()
        self.assertEqual(state["next_id"], 2)
        self.assertEqual(state["reminders"][0]["state"], "canceled")

    def test_recurring_and_timezone_normalization(self):
        created = json.loads(
            tools.choomfie_reminder_create(
                {"message": "stand up", "schedule": "daily at 9am", "timezone": "America/Toronto"},
                ctx=self.ctx,
            )
        )

        self.assertTrue(created["success"])
        self.assertEqual(created["reminder"]["recurrence"], "daily")
        self.assertEqual(created["reminder"]["schedule"], "0 9 * * *")
        self.assertNotIn("repeat", self.ctx.calls[0][1])

        invalid = json.loads(
            tools.choomfie_reminder_create(
                {"message": "bad", "schedule": "daily at 9am", "timezone": "Mars/Base"},
                ctx=self.ctx,
            )
        )
        self.assertFalse(invalid["success"])
        self.assertIn("Invalid timezone", invalid["error"])

        non_profile_tz = json.loads(
            tools.choomfie_reminder_create(
                {"message": "bad", "schedule": "daily at 9am", "timezone": "Asia/Tokyo"},
                ctx=self.ctx,
            )
        )
        self.assertFalse(non_profile_tz["success"])
        self.assertIn("profile timezone", non_profile_tz["error"])

    def test_snooze_and_ack_update_local_state(self):
        created = json.loads(tools.choomfie_reminder_create({"message": "stretch", "schedule": "30m"}, ctx=self.ctx))
        snoozed = json.loads(tools.choomfie_reminder_snooze({"id": created["reminder"]["id"], "duration": "1h"}, ctx=self.ctx))

        self.assertTrue(snoozed["success"])
        self.assertEqual(snoozed["snoozed_from_id"], 1)
        self.assertEqual(snoozed["reminder"]["id"], 2)
        self.assertEqual(snoozed["reminder"]["schedule"], "1h")

        acked = json.loads(tools.choomfie_reminder_ack({"id": 2}, ctx=self.ctx))
        self.assertTrue(acked["success"])
        self.assertEqual(acked["reminder"]["state"], "acknowledged")

    def test_list_reconciles_fired_one_shot_jobs(self):
        created = json.loads(tools.choomfie_reminder_create({"message": "drink water", "schedule": "30m"}, ctx=self.ctx))
        script = Path(self.temp.name) / "scripts" / "choomfie-reminders" / "reminder-1.py"
        self.assertTrue(script.exists())
        self.ctx.jobs.pop(created["reminder"]["cron_job_id"])

        active = json.loads(tools.choomfie_reminder_list({}, ctx=self.ctx))
        self.assertTrue(active["success"])
        self.assertEqual(active["count"], 0)
        self.assertFalse(script.exists())

        history = json.loads(tools.choomfie_reminder_list({"include_history": True}, ctx=self.ctx))
        self.assertEqual(history["count"], 1)
        self.assertEqual(history["reminders"][0]["state"], "fired")
        self.assertIsNotNone(history["reminders"][0]["last_fired_at"])


if __name__ == "__main__":
    unittest.main()
