"""
python -m evals <command>

  validate      check scenario files and label_map.yaml
  extract       draft scenarios from the user-story Markdown files
  smoke         one tagged message against the live API (needs --yes)
  run           probes + journeys (+ judge, optional Bedrock eval, report) (needs --yes)
  judge         score a run's journey transcripts with the direct LLM judge
  bedrock-eval  start (and optionally wait for) Bedrock Evaluations jobs for a run
  report        rebuild report.md / report.json for a run
  transcripts   one readable Markdown file of conversations, scores and judge notes

Settings come from environment variables (see evals/README.md); --env-file
loads them from a file such as evals/.env.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import List, Optional

from evals import config as config_mod
from evals.schema import (
    ScenarioError,
    load_label_map,
    load_scenarios,
    scoring_problems,
    select_scenarios,
    validate_directory,
)

EVALS_DIR = Path(__file__).resolve().parent
SCENARIOS_DIR = EVALS_DIR / "scenarios"
RESULTS_DIR = EVALS_DIR / "results"
SMOKE_MESSAGE = "My son keeps getting sent home from school before lunch. What can I do?"


def _csv(value: Optional[str]) -> Optional[List[str]]:
    return [v.strip() for v in value.split(",") if v.strip()] if value else None


def _confirm(settings, what: str, yes: bool) -> None:
    print(f"Target API: {settings.api_url}")
    print(f"Target WebSocket: {settings.ws_url}")
    print(what)
    if not yes:
        raise SystemExit("This sends real traffic to the configured stack. Re-run with --yes to proceed.")


def _run_dir(run_id: str) -> Path:
    path = RESULTS_DIR / run_id
    if not path.exists():
        raise SystemExit(f"no results for run {run_id} in {RESULTS_DIR}")
    return path


# ------------------------------------------------------------------
# Commands
# ------------------------------------------------------------------

def cmd_validate(args) -> int:
    problems = validate_directory(Path(args.scenarios), for_scoring=args.for_scoring)
    if problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print(f"- {p}")
        return 1
    scenarios = load_scenarios(Path(args.scenarios))
    reviewed = sum(1 for s in scenarios if s.reviewed)
    testable = sum(1 for s in scenarios if s.testable)
    print(f"OK: {len(scenarios)} scenario(s), {reviewed} reviewed, {testable} testable.")
    return 0


def cmd_extract(args) -> int:
    from evals import catalog as catalog_mod
    from evals.extract import extract

    settings = config_mod.Settings.from_env()
    catalog = None
    if args.catalog == "repo":
        catalog = catalog_mod.catalog_from_repo()
    elif args.catalog == "admin":
        from evals.harness.client import ApiClient

        settings.require("api_url", "admin_id_token")
        catalog = catalog_mod.catalog_from_admin_tree(ApiClient(settings).admin_get("/admin/journeys") or {})

    bedrock_client = None
    if not args.no_llm:
        from evals.bedrock import runtime_client

        bedrock_client = runtime_client(settings.bedrock_region)
        print(f"Drafting personas/messages with {settings.extract_model} in {settings.bedrock_region}")

    result = extract(
        Path(args.source), Path(args.out), bedrock_client=bedrock_client, model_id=settings.extract_model,
        catalog=catalog, overwrite=args.overwrite, fill_missing=args.fill_missing,
    )
    print(f"Wrote {len(result.written)} draft(s); kept {len(result.kept_reviewed)} reviewed scenario(s).")
    if result.filled:
        print(f"Filled empty drafted fields in {len(result.filled)} file(s): {', '.join(sorted(result.filled))}")
    if result.reopened:
        print(f"Set back to reviewed: false so the new fields get checked: {', '.join(result.reopened)}")
    if result.unmatched_journeys:
        print(f"Journeys without a catalog key (fill in label_map.yaml): {result.unmatched_journeys}")
    if result.stories_without_clusters:
        print(f"Stories without expected clusters ({len(result.stories_without_clusters)}): "
              + ", ".join(result.stories_without_clusters))
    for p in result.problems:
        print(f"! {p}")
    print("Next: review each draft, set reviewed: true (and testable: false where the chat cannot do it), "
          "then review label_map.yaml and set reviewed: true.")
    return 0


def _clients(settings, need_simulator: bool):
    from evals.bedrock import runtime_client
    from evals.harness.client import ApiClient
    from evals.harness.signing import SigningKeyProvider
    from evals.harness.simulator import ParentSimulator

    settings.require("api_url", "ws_url")
    client = ApiClient(settings)
    keys = SigningKeyProvider(settings.secret_name, settings.aws_region)
    simulator = ParentSimulator(runtime_client(settings.bedrock_region), settings.simulator_model) if need_simulator else None
    return client, keys, simulator


def _global_mode(client) -> Optional[str]:
    if not client.settings.admin_id_token:
        return None
    try:
        return client.global_prompt_mode()
    except Exception as e:  # noqa: BLE001 - informational only
        print(f"(could not read global prompt mode: {type(e).__name__})")
        return None


def cmd_smoke(args) -> int:
    from evals.harness.runner import new_run_id
    from evals.harness.signing import make_tag

    settings = config_mod.Settings.from_env()
    _confirm(settings, f"Smoke test: 1 anonymous user, 1 tagged {args.mode}-mode session, 1 message.", args.yes)
    client, keys, _ = _clients(settings, need_simulator=False)
    run_id = new_run_id("smoke")

    totals_before = None
    if client.settings.admin_id_token:
        totals_before = client.analytics_totals()
    mode_before = _global_mode(client)

    user = client.create_user(run_id)
    session_id = client.create_session(user, make_tag(keys.key(), user.user_id, run_id, args.mode), title="eval smoke")
    with client.chat(user) as chat:
        result = chat.send(session_id, args.message or SMOKE_MESSAGE)
    routing = client.routing_snapshot(user, session_id) if result.ok else {}
    print(f"Run id: {run_id}")
    print(f"Reply: phase={result.phase} chars={len(result.response)} sources={len(result.sources)} "
          f"warning={'yes' if result.warning else 'no'} error={result.error} elapsed={result.elapsed}s")
    print(f"Routing: journey={routing.get('journey')} situation={routing.get('situation')} "
          f"confidence={routing.get('confidence')}")

    ok = result.ok
    if totals_before is not None:
        totals_after = client.analytics_totals()
        same = totals_after.get("chat_sessions") == totals_before.get("chat_sessions")
        print(f"Admin analytics chat_sessions before/after: {totals_before.get('chat_sessions')}/"
              f"{totals_after.get('chat_sessions')} -> {'excluded' if same else 'NOT excluded (or live traffic)'}")
    mode_after = _global_mode(client)
    if mode_before is not None:
        print(f"Global prompt mode before/after: {mode_before}/{mode_after}")
    client.delete_session(user, session_id)
    print("Session deleted.")
    return 0 if ok else 1


def _judge_run(run_dir: Path, scenarios_by_id, settings, force: bool = False) -> int:
    from evals.bedrock import runtime_client
    from evals.judge.judge import Judge

    judge = Judge(runtime_client(settings.bedrock_region), settings.judge_model)
    out_dir = run_dir / "judge"
    out_dir.mkdir(exist_ok=True)
    count = 0
    for path in sorted((run_dir / "journeys").glob("*.json")):
        target = out_dir / path.name
        if target.exists() and not force:
            continue
        transcript = json.loads(path.read_text(encoding="utf-8"))
        scenario = scenarios_by_id.get(transcript.get("story_id"))
        if scenario is None:
            print(f"skip {path.name}: scenario not found")
            continue
        try:
            result = judge.assess(scenario, transcript)
        except Exception as e:  # noqa: BLE001 - keep judging the rest
            result = {"story_id": transcript.get("story_id"), "mode": transcript.get("mode"), "error": type(e).__name__}
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        count += 1
        print(f"judged {path.stem}: {json.dumps(result.get('scores') or {'error': result.get('error')})}")
    return count


def cmd_judge(args) -> int:
    from evals import report

    settings = config_mod.Settings.from_env()
    run_dir = _run_dir(args.run)
    scenarios = {s.story_id: s for s in load_scenarios(Path(args.scenarios))}
    _judge_run(run_dir, scenarios, settings, force=args.force)
    rep = report.write(run_dir)
    print(json.dumps(rep["judge"], indent=2))
    return 0


def _bedrock_client(settings):
    import boto3

    from evals.judge.bedrock_eval import BedrockEvaluation

    settings.require("eval_bucket", "eval_role_arn")
    region = settings.eval_job_region or settings.aws_region
    return BedrockEvaluation(
        boto3.client("bedrock", region_name=region), boto3.client("s3", region_name=region),
        settings.eval_bucket, settings.eval_role_arn, settings.judge_model,
    )


def _existing_jobs(run_dir: Path) -> List[dict]:
    out_dir = run_dir / "bedrock"
    if not out_dir.exists():
        return []
    jobs = []
    for path in sorted(out_dir.glob("*.json")):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if job.get("job_arn"):
            jobs.append(job)
    return jobs


def _finish_jobs(run_dir: Path, evaluation, jobs: List[dict], wait: bool) -> None:
    """Wait for (optional) and record each job's status, reading metrics once Completed."""
    out_dir = run_dir / "bedrock"
    for job in jobs:
        if wait and job.get("status") not in ("Completed", "Failed", "Stopped"):
            print(f"waiting for {job['job_name']} (large jobs can take hours)...")
            job.update(evaluation.wait(job["job_arn"]))
        else:
            job.update(evaluation.status(job["job_arn"]))
        if job.get("status") == "Completed" and not job.get("metrics"):
            job["metrics"] = evaluation.results(job["output_prefix"])
        (out_dir / f"{job['mode']}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        print(f"{job['mode']}: {job.get('status')}" + (f" ({len(job['metrics'])} metrics)" if job.get("metrics") else ""))


def _bedrock_eval(run_dir: Path, scenarios_by_id, settings, wait: bool, new: bool = False) -> List[dict]:
    from evals.judge.bedrock_eval import build_datasets

    existing = _existing_jobs(run_dir)
    if existing and not new:
        names = ", ".join(f"{j['mode']} ({j.get('status') or 'started'})" for j in existing)
        raise SystemExit(
            f"this run already has Bedrock jobs: {names}. Use --collect to fetch their results, "
            "or --new to start (and pay for) new jobs."
        )
    transcripts = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((run_dir / "journeys").glob("*.json"))]
    datasets = build_datasets(scenarios_by_id, transcripts)
    if not datasets:
        print("no transcripts with a reply to evaluate")
        return []
    evaluation = _bedrock_client(settings)
    out_dir = run_dir / "bedrock"
    out_dir.mkdir(exist_ok=True)
    jobs = []
    suffix = f"-{int(time.time())}" if existing else ""
    for mode, records in sorted(datasets.items()):
        job = evaluation.start(run_dir.name, mode, records, suffix=suffix)
        (out_dir / f"{mode}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        jobs.append(job)
    if wait:
        _finish_jobs(run_dir, evaluation, jobs, wait=True)
    return jobs


def _collect(run_dir: Path, settings, wait: bool) -> List[dict]:
    jobs = _existing_jobs(run_dir)
    if not jobs:
        raise SystemExit(f"no Bedrock jobs recorded in {run_dir / 'bedrock'}; run bedrock-eval first")
    _finish_jobs(run_dir, _bedrock_client(settings), jobs, wait=wait)
    return jobs


def cmd_bedrock_eval(args) -> int:
    from evals import report

    settings = config_mod.Settings.from_env()
    run_dir = _run_dir(args.run)
    if args.collect:
        _collect(run_dir, settings, wait=args.wait)
    else:
        scenarios = {s.story_id: s for s in load_scenarios(Path(args.scenarios))}
        _bedrock_eval(run_dir, scenarios, settings, wait=args.wait, new=args.new)
    report.write(run_dir)
    return 0


def cmd_run(args) -> int:
    from evals import report
    from evals.harness.runner import RunConfig, Runner, new_run_id

    settings = config_mod.Settings.from_env()
    directory = Path(args.scenarios)
    scenarios = load_scenarios(directory)
    label_map = load_label_map(directory)
    selected = select_scenarios(
        scenarios, stories=_csv(args.stories), journey=args.journey, limit=args.limit, for_scoring=True,
    )
    if not selected:
        raise SystemExit("no scenarios selected")
    problems = scoring_problems(selected, label_map)
    if problems and not args.allow_unlabelled:
        print("\n".join(f"- {p}" for p in problems))
        raise SystemExit("fix the problems above (or pass --allow-unlabelled to run without routing labels)")

    modes = _csv(args.modes)
    probes = not args.journeys_only
    journeys = not args.probes_only
    probe_count = sum(1 + sum(1 for c in s.variants + s.negative_cases if c.message) for s in selected) if probes else 0
    journey_count = sum(len(modes or s.modes) for s in selected) if journeys else 0
    max_turns = args.max_turns or settings.max_turns
    _confirm(
        settings,
        f"Run: {len(selected)} stories, {probe_count} probes, {journey_count} journeys "
        f"(up to {max_turns} turns), about {probe_count + journey_count} anonymous users and up to "
        f"{probe_count + journey_count * max_turns} messages, sequential.",
        args.yes,
    )

    client, keys, simulator = _clients(settings, need_simulator=journeys)
    run_id = args.run_id or new_run_id()
    runner = Runner(
        client, keys, simulator,
        RunConfig(
            run_id=run_id, modes=modes, max_turns=max_turns, follow_up_turns=args.follow_up_turns,
            probes=probes, journeys=journeys, turn_delay=settings.turn_delay, user_delay=settings.user_delay,
            keep_sessions=args.keep_sessions,
        ),
        label_map=label_map, results_root=RESULTS_DIR,
    )
    mode_before = _global_mode(client)
    manifest = runner.run(selected, manifest_extra={
        "simulator_model": settings.simulator_model if journeys else None,
        "judge_model": settings.judge_model,
        "global_prompt_mode_before": mode_before,
    })
    mode_after = _global_mode(client)
    manifest["global_prompt_mode_after"] = mode_after
    (RESULTS_DIR / run_id / "run.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if mode_before and mode_after and mode_before != mode_after:
        print(f"WARNING: global prompt mode changed during the run ({mode_before} -> {mode_after}); "
              "the harness never changes it, so an admin did.")

    by_id = {s.story_id: s for s in scenarios}
    run_dir = RESULTS_DIR / run_id
    if journeys and not args.no_judge:
        _judge_run(run_dir, by_id, settings)
    if journeys and args.bedrock_eval:
        _bedrock_eval(run_dir, by_id, settings, wait=args.wait)
    rep = report.write(run_dir)
    print(f"Report: {run_dir / 'report.md'}")
    print(f"Transcripts: {run_dir / 'transcripts.md'}")
    print(json.dumps({"routing": {k: rep["routing"][k] for k in ("probes", "negatives")}, "judge": rep["judge"]}, indent=2))
    if manifest.get("cleanup_failed"):
        print(f"WARNING: {len(manifest['cleanup_failed'])} session(s) could not be deleted (eval_run_id={run_id}).")
    return 0


def cmd_transcripts(args) -> int:
    from evals import transcripts

    run_dirs = [_run_dir(r) for r in args.run] if args.run else sorted(
        p for p in RESULTS_DIR.iterdir() if p.is_dir()
    ) if RESULTS_DIR.exists() else []
    if not run_dirs:
        raise SystemExit(f"no runs in {RESULTS_DIR}")
    scenarios = {s.story_id: s for s in load_scenarios(Path(args.scenarios))}
    stamp = __import__("datetime").datetime.now().strftime("%Y%m%d")
    out = Path(args.out) if args.out else RESULTS_DIR / f"transcripts_{stamp}.md"
    info = transcripts.write(run_dirs, scenarios, out)
    print(f"Wrote {info['conversations']} conversations ({info['stories']} stories) and "
          f"{info['probe_files']} probe tables from {len(info['runs'])} run(s) to {info['path']}")
    return 0


def cmd_report(args) -> int:
    from evals import report

    run_dir = _run_dir(args.run)
    rep = report.write(run_dir)
    print(f"Report: {run_dir / 'report.md'}")
    print(f"Transcripts: {run_dir / 'transcripts.md'}")
    print(json.dumps(rep["judge"], indent=2))
    return 0


# ------------------------------------------------------------------
# Parser
# ------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m evals", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env-file", help="load settings from a KEY=VALUE file (e.g. evals/.env)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="check scenarios and label_map.yaml")
    p.add_argument("--scenarios", default=str(SCENARIOS_DIR))
    p.add_argument("--for-scoring", action="store_true", help="also require reviewed scenarios and labels")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("extract", help="draft scenarios from user-story Markdown files")
    p.add_argument("--source", required=True, help="folder with User_Stories_*.md files")
    p.add_argument("--out", default=str(SCENARIOS_DIR))
    p.add_argument("--no-llm", action="store_true", help="deterministic fields only (no Bedrock call)")
    p.add_argument("--catalog", choices=["repo", "admin", "none"], default="repo",
                   help="journey catalog for label suggestions (default: repo fallback catalog)")
    p.add_argument("--overwrite", action="store_true", help="also rewrite scenarios marked reviewed")
    p.add_argument("--fill-missing", action="store_true",
                   help="keep existing files as they are and only draft empty persona/hidden facts/probe messages "
                        "(reviewed files that change go back to reviewed: false)")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("smoke", help="one tagged message against the live API")
    p.add_argument("--mode", choices=["standard", "guideline"], default="standard")
    p.add_argument("--message", help="synthetic parent message (default: a generic one)")
    p.add_argument("--yes", action="store_true", help="confirm sending real traffic")
    p.set_defaults(func=cmd_smoke)

    p = sub.add_parser("run", help="probes + journeys + judge + report")
    p.add_argument("--scenarios", default=str(SCENARIOS_DIR))
    p.add_argument("--modes", help="comma list overriding each scenario's modes, e.g. standard,guideline")
    p.add_argument("--stories", help="comma list of story ids")
    p.add_argument("--journey", type=int, help="only this journey number")
    p.add_argument("--limit", type=int, default=3, help="max stories (default 3; small batches)")
    p.add_argument("--max-turns", type=int)
    p.add_argument("--follow-up-turns", type=int, default=0, help="extra parent turns after first guidance")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--probes-only", action="store_true")
    group.add_argument("--journeys-only", action="store_true")
    p.add_argument("--no-judge", action="store_true")
    p.add_argument("--bedrock-eval", action="store_true", help="also start Bedrock Evaluations jobs")
    p.add_argument("--wait", action="store_true", help="wait for Bedrock jobs and merge their metrics")
    p.add_argument("--keep-sessions", action="store_true", help="do not delete sessions (they stay excluded from analytics)")
    p.add_argument("--allow-unlabelled", action="store_true", help="run even if label_map.yaml is incomplete")
    p.add_argument("--run-id")
    p.add_argument("--yes", action="store_true", help="confirm sending real traffic")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("judge", help="judge a run's transcripts")
    p.add_argument("--run", required=True)
    p.add_argument("--scenarios", default=str(SCENARIOS_DIR))
    p.add_argument("--force", action="store_true", help="re-judge transcripts already judged")
    p.set_defaults(func=cmd_judge)

    p = sub.add_parser("bedrock-eval", help="Bedrock Evaluations jobs for a run")
    p.add_argument("--run", required=True)
    p.add_argument("--scenarios", default=str(SCENARIOS_DIR))
    p.add_argument("--wait", action="store_true", help="wait for the jobs to finish")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--collect", action="store_true",
                       help="do not start jobs; check the run's existing jobs and fetch results of completed ones")
    group.add_argument("--new", action="store_true", help="start new jobs even if this run already has some")
    p.set_defaults(func=cmd_bedrock_eval)

    p = sub.add_parser("transcripts", help="one combined Markdown file of conversations, scores and judge notes across runs")
    p.add_argument("--run", action="append", help="run id (repeatable); default: every run in evals/results")
    p.add_argument("--scenarios", default=str(SCENARIOS_DIR))
    p.add_argument("--out", help="output file (default: evals/results/transcripts_<date>.md)")
    p.set_defaults(func=cmd_transcripts)

    p = sub.add_parser("report", help="rebuild a run's report.md, report.json and transcripts.md")
    p.add_argument("--run", required=True)
    p.set_defaults(func=cmd_report)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.env_file:
        config_mod.load_env_file(args.env_file)
    try:
        return args.func(args)
    except ScenarioError as e:
        print(f"scenario error:\n{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
