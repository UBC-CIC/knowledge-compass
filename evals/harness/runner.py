"""
Runs routing probes and full journeys against the live API, one fresh
anonymous user per probe/journey, strictly sequentially (concurrency 1).

Results go to evals/results/<run_id>/:
  probes/<story_id>.json            single-message routing probes
  journeys/<story_id>_<mode>.json   multi-turn transcripts
  run.json                          run manifest (settings, selection, cleanup)

Every session is created with a signed eval tag, so it is excluded from admin
analytics, and is deleted through the public API once its result is saved.
"""

from __future__ import annotations

import datetime as _dt
import json
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from evals.harness.client import ApiClient, ApiError, EvalUser, TurnResult
from evals.harness.signing import SigningKeyProvider, make_tag
from evals.harness.simulator import ParentSimulator
from evals.schema import LabelMap, Scenario

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
SOURCE_PREVIEW_CHARS = 600


def new_run_id(prefix: str = "run") -> str:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{stamp}_{secrets.token_hex(3)}"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _public_sources(sources: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for s in sources or []:
        if not isinstance(s, dict):
            continue
        out.append({
            "title": s.get("title"),
            "url": s.get("url") or s.get("uri"),
            "source_type": s.get("source_type"),
            "content": (s.get("content") or "")[:SOURCE_PREVIEW_CHARS],
        })
    return out


def is_guidance(result: TurnResult, mode: str) -> bool:
    """Guidance turn: SUGGESTION in standard mode; a cited answer in guideline mode
    (guideline mode always reports SUGGESTION, and clarifying turns cite nothing)."""
    if mode == "guideline":
        return result.phase == "SUGGESTION" and bool(result.sources)
    return result.phase == "SUGGESTION"


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


@dataclass
class RunConfig:
    run_id: str
    # None = each scenario's own modes; a list (--modes) overrides them.
    modes: Optional[Sequence[str]] = None
    max_turns: int = 8
    follow_up_turns: int = 0
    probes: bool = True
    journeys: bool = True
    turn_delay: float = 2.0
    user_delay: float = 5.0
    keep_sessions: bool = False


@dataclass
class RunState:
    cleanup_failed: List[Dict[str, str]] = field(default_factory=list)
    sessions_created: int = 0
    sessions_deleted: int = 0
    users_created: int = 0
    errors: List[str] = field(default_factory=list)


class Runner:
    def __init__(
        self,
        client: ApiClient,
        keys: SigningKeyProvider,
        simulator: Optional[ParentSimulator],
        config: RunConfig,
        label_map: Optional[LabelMap] = None,
        results_root: Path = RESULTS_DIR,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
    ):
        self.client = client
        self.keys = keys
        self.simulator = simulator
        self.config = config
        self.label_map = label_map or LabelMap()
        self.out = Path(results_root) / config.run_id
        self.sleep = sleep
        self.log = log
        self.state = RunState()
        self._first_user = True

    # -- helpers ---------------------------------------------------

    def _new_user(self) -> EvalUser:
        if not self._first_user:
            self.sleep(self.config.user_delay)
        self._first_user = False
        user = self.client.create_user(self.config.run_id)
        self.state.users_created += 1
        return user

    def _new_session(self, user: EvalUser, mode: str, title: str) -> str:
        tag = make_tag(self.keys.key(), user.user_id, self.config.run_id, mode)
        session_id = self.client.create_session(user, tag, title=title)
        self.state.sessions_created += 1
        return session_id

    def _cleanup(self, user: EvalUser, session_id: str) -> bool:
        if self.config.keep_sessions:
            return False
        try:
            self.client.delete_session(user, session_id)
            self.state.sessions_deleted += 1
            return True
        except ApiError as e:
            self.state.cleanup_failed.append({"user_id": user.user_id, "session_id": session_id, "error": str(e)})
            return False

    def _expected(self, scenario: Scenario) -> Dict[str, Any]:
        return {
            "journey_key": self.label_map.journey_key(scenario),
            "clusters": self.label_map.cluster_keys(scenario),
        }

    @staticmethod
    def _turn_record(index: int, message: str, result: TurnResult, routing: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "index": index,
            "user": message,
            "response": result.response,
            "phase": result.phase,
            "sources": _public_sources(result.sources),
            "warning": result.warning,
            "error": result.error,
            "error_message": result.error_message,
            "limited": result.limited,
            "elapsed": result.elapsed,
            "routing": routing,
        }

    # -- probes ----------------------------------------------------

    def run_probe(self, scenario: Scenario, kind: str, description: str, message: str) -> Dict[str, Any]:
        """One first-turn message in a fresh standard-mode session; records routing."""
        record: Dict[str, Any] = {
            "story_id": scenario.story_id, "kind": kind, "description": description,
            "message": message, "mode": "standard", "started_at": _now(),
        }
        user = self._new_user()
        session_id = self._new_session(user, "standard", f"eval {scenario.story_id} {kind}")
        try:
            with self.client.chat(user) as chat:
                result = chat.send(session_id, message)
            routing = self.client.routing_snapshot(user, session_id) if result.ok else {}
            record.update(self._turn_record(0, message, result, routing))
        finally:
            record["cleaned_up"] = self._cleanup(user, session_id)
        return record

    def run_probes(self, scenario: Scenario) -> Dict[str, Any]:
        cases = [("opening", "main scenario opening message", scenario.opening_message)]
        cases += [("variant", v.description, v.message) for v in scenario.variants if v.message]
        cases += [("negative", n.description, n.message) for n in scenario.negative_cases if n.message]
        skipped = [v.description for v in scenario.variants + scenario.negative_cases if not v.message]
        results = []
        for kind, description, message in cases:
            try:
                results.append(self.run_probe(scenario, kind, description, message))
            except Exception as e:  # noqa: BLE001 - one failed probe must not stop the run
                self.state.errors.append(f"{scenario.story_id} probe: {type(e).__name__}: {e}")
                results.append({"story_id": scenario.story_id, "kind": kind, "description": description,
                                "message": message, "error": str(e)})
            self.sleep(self.config.turn_delay)
        out = {
            "run_id": self.config.run_id, "story_id": scenario.story_id,
            "journey_number": scenario.journey_number, "expected": self._expected(scenario),
            "probes": results, "skipped_without_message": skipped,
        }
        _write_json(self.out / "probes" / f"{scenario.story_id}.json", out)
        return out

    # -- journeys --------------------------------------------------

    def run_journey(self, scenario: Scenario, mode: str) -> Dict[str, Any]:
        transcript: Dict[str, Any] = {
            "run_id": self.config.run_id,
            "story_id": scenario.story_id,
            "mode": mode,
            "kind": "journey",
            "started_at": _now(),
            "scenario": {
                "journey_number": scenario.journey_number,
                "journey_name": scenario.journey_name,
                "feature": scenario.feature,
                "story_text": scenario.story_text,
            },
            "expected": self._expected(scenario),
            "turns": [],
            "outcome": {},
        }
        user = self._new_user()
        session_id = self._new_session(user, mode, f"eval {scenario.story_id}")
        turns: List[Dict[str, Any]] = transcript["turns"]
        stopped, guidance_turn, guidance_seen = "max_turns", None, 0
        try:
            with self.client.chat(user) as chat:
                message = scenario.opening_message
                for index in range(self.config.max_turns):
                    result = chat.send(session_id, message)
                    routing = self.client.routing_snapshot(user, session_id) if result.ok else {}
                    turns.append(self._turn_record(index, message, result, routing))
                    if result.limited:
                        stopped = "limit"
                        break
                    if not result.ok:
                        stopped = "error"
                        break
                    if is_guidance(result, mode):
                        guidance_seen += 1
                        if guidance_turn is None:
                            guidance_turn = index
                        if guidance_seen > self.config.follow_up_turns:
                            stopped = "guidance"
                            break
                    if index == self.config.max_turns - 1:
                        break
                    if self.simulator is None:
                        stopped = "no_simulator"
                        break
                    message = self.simulator.reply(scenario, turns)
                    if not message:
                        stopped = "simulator"
                        break
                    if not user.has_budget(len(message)):
                        stopped = "budget"
                        break
                    self.sleep(self.config.turn_delay)
        finally:
            transcript["outcome"] = {
                "stopped": stopped,
                "reached_guidance": guidance_turn is not None,
                "guidance_turn": guidance_turn,
                "turns": len(turns),
            }
            transcript["finished_at"] = _now()
            _write_json(self.out / "journeys" / f"{scenario.story_id}_{mode}.json", transcript)
            transcript["cleaned_up"] = self._cleanup(user, session_id)
            _write_json(self.out / "journeys" / f"{scenario.story_id}_{mode}.json", transcript)
        return transcript

    # -- whole run -------------------------------------------------

    def run(self, scenarios: Sequence[Scenario], manifest_extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        manifest: Dict[str, Any] = {
            "run_id": self.config.run_id,
            "started_at": _now(),
            "modes": list(self.config.modes) if self.config.modes else "per scenario",
            "stories": [s.story_id for s in scenarios],
            "max_turns": self.config.max_turns,
            "probes": self.config.probes,
            "journeys": self.config.journeys,
            **(manifest_extra or {}),
        }
        _write_json(self.out / "run.json", manifest)
        for scenario in scenarios:
            self.log(f"[{scenario.story_id}] {scenario.story_text[:70]}")
            if self.config.probes and "standard" in scenario.modes:
                self.run_probes(scenario)
            if self.config.journeys:
                for mode in (self.config.modes or scenario.modes):
                    try:
                        outcome = self.run_journey(scenario, mode)["outcome"]
                        self.log(f"  {mode}: {outcome['stopped']} after {outcome['turns']} turn(s)")
                    except Exception as e:  # noqa: BLE001 - one failed journey must not stop the run
                        self.state.errors.append(f"{scenario.story_id} {mode}: {type(e).__name__}: {e}")
                        self.log(f"  {mode}: failed ({type(e).__name__})")
        manifest.update({
            "finished_at": _now(),
            "users_created": self.state.users_created,
            "sessions_created": self.state.sessions_created,
            "sessions_deleted": self.state.sessions_deleted,
            "cleanup_failed": self.state.cleanup_failed,
            "errors": self.state.errors,
        })
        _write_json(self.out / "run.json", manifest)
        return manifest
