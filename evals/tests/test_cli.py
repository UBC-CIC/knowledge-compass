import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from evals import cli
from evals.judge import judge as judge_mod
from evals.tests.fakes import FakeBackend
from evals.tests.test_client import make_client
from evals.tests.test_runner import FakeSimulator, _keys
from evals.tests.test_scoring import ASSESSMENT

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ENV = {"KC_API_URL": "https://api.example.test/prod", "KC_WS_URL": "wss://ws.example.test/prod",
       "KC_TURN_DELAY_SECONDS": "0", "KC_USER_DELAY_SECONDS": "0", "KC_EVAL_BUCKET": "bucket",
       "KC_EVAL_ROLE_ARN": "arn:aws:iam::111111111111:role/eval"}


def _judge_client():
    client = mock.Mock()
    client.converse.return_value = {"output": {"message": {"content": [
        {"toolUse": {"name": judge_mod.JUDGE_TOOL, "input": ASSESSMENT}}]}}}
    return client


def run_cli(argv):
    out = io.StringIO()
    with redirect_stdout(out):
        code = cli.main(argv)
    return code, out.getvalue()


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.results = Path(self.tmp.name) / "results"
        self.patches = [
            mock.patch.object(cli, "RESULTS_DIR", self.results),
            mock.patch.dict(os.environ, ENV),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_validate(self):
        code, out = run_cli(["validate", "--scenarios", str(FIXTURES / "scenarios"), "--for-scoring"])
        self.assertEqual(code, 0)
        self.assertIn("OK: 1 scenario(s), 1 reviewed", out)

    def test_extract_no_llm(self):
        src = Path(self.tmp.name) / "src"
        src.mkdir()
        shutil.copy(FIXTURES / "stories_excerpt.md", src / "stories.md")
        out_dir = Path(self.tmp.name) / "scenarios"
        code, out = run_cli(["extract", "--source", str(src), "--out", str(out_dir), "--no-llm"])
        self.assertEqual(code, 0)
        self.assertIn("Wrote 3 draft(s)", out)
        code, out = run_cli(["validate", "--scenarios", str(out_dir), "--for-scoring"])
        self.assertEqual(code, 1)
        self.assertIn("not reviewed", out)

    def test_run_refuses_without_yes(self):
        with self.assertRaises(SystemExit) as ctx:
            run_cli(["run", "--scenarios", str(FIXTURES / "scenarios")])
        self.assertIn("--yes", str(ctx.exception))

    def test_run_end_to_end_against_fake_backend(self):
        backend = FakeBackend()
        client, _ = make_client(backend, admin_id_token="admin-token")
        with mock.patch.object(cli, "_clients", return_value=(client, _keys(), FakeSimulator())), \
                mock.patch("evals.bedrock.runtime_client", return_value=_judge_client()):
            code, out = run_cli(["run", "--scenarios", str(FIXTURES / "scenarios"), "--modes", "standard,guideline",
                                 "--run-id", "run_cli", "--yes"])
        self.assertEqual(code, 0, out)
        run = self.results / "run_cli"
        self.assertTrue((run / "report.md").exists())
        rep = json.loads((run / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(rep["routing"]["probes"]["count"], 2)
        self.assertEqual(rep["routing"]["negatives"]["count"], 1)
        self.assertEqual(sorted(rep["judge"]), ["guideline", "standard"])
        self.assertEqual(rep["mode_comparison"]["stories"], 1)
        manifest = json.loads((run / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["global_prompt_mode_before"], "standard")
        self.assertEqual(manifest["global_prompt_mode_after"], "standard")
        # No eval session is left behind and none counted as real traffic.
        self.assertEqual(backend.sessions, {})
        self.assertEqual(manifest["sessions_created"], manifest["sessions_deleted"])
        # Never sends feedback.
        self.assertFalse(any("feedback" in r["path"] for r in backend.requests))

    def test_bedrock_eval_command(self):
        backend = FakeBackend()
        client, _ = make_client(backend)
        with mock.patch.object(cli, "_clients", return_value=(client, _keys(), FakeSimulator())), \
                mock.patch("evals.bedrock.runtime_client", return_value=_judge_client()):
            run_cli(["run", "--scenarios", str(FIXTURES / "scenarios"), "--journeys-only", "--no-judge",
                     "--run-id", "run_b", "--yes"])
        bedrock, s3 = mock.Mock(), mock.Mock()
        bedrock.create_evaluation_job.return_value = {"jobArn": "arn:job"}
        bedrock.get_evaluation_job.return_value = {"status": "Completed"}
        s3.list_objects_v2.return_value = {"Contents": []}
        with mock.patch("boto3.client", side_effect=lambda svc, region_name=None: bedrock if svc == "bedrock" else s3), \
                mock.patch("evals.judge.bedrock_eval.time.sleep"):
            code, _ = run_cli(["bedrock-eval", "--run", "run_b", "--scenarios", str(FIXTURES / "scenarios"), "--wait"])
        self.assertEqual(code, 0)
        job = json.loads((self.results / "run_b" / "bedrock" / "standard.json").read_text(encoding="utf-8"))
        self.assertEqual(job["status"], "Completed")
        self.assertEqual(bedrock.create_evaluation_job.call_args.kwargs["roleArn"], ENV["KC_EVAL_ROLE_ARN"])

    def test_smoke(self):
        backend = FakeBackend()
        client, _ = make_client(backend, admin_id_token="admin-token")
        with mock.patch.object(cli, "_clients", return_value=(client, _keys(), None)):
            code, out = run_cli(["smoke", "--yes"])
        self.assertEqual(code, 0, out)
        self.assertIn("Routing: journey=J1 situation=A", out)
        self.assertIn("-> excluded", out)
        self.assertIn("Session deleted.", out)
        self.assertEqual(backend.sessions, {})


if __name__ == "__main__":
    unittest.main()
