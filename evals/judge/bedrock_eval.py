"""
Amazon Bedrock Evaluations job (RAG, retrieve-and-generate, "bring your own
inference responses") over a run's journey transcripts.

Dataset (JSONL, max 1000 records, one RAG source per job, so one job per mode):

  {"conversationTurns": [{
      "prompt": {"content": [{"text": <conversation so far + final parent turn>}]},
      "referenceResponses": [{"content": [{"text": <acceptance criteria + reference flow>}]}],
      "output": {
          "text": <guidance reply>,
          "knowledgeBaseIdentifier": "knowledge-compass-<mode>",
          "modelIdentifier": "knowledge-compass",
          "retrievedPassages": {"retrievalResults": [{"name": ..., "content": {"text": ...}}]}
      }}]}

Retrieved passages are the public source previews the chat returns (trimmed
by to_public_source), so faithfulness scores are approximate.

Schema per https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-evaluation-prompt-retrieve-generate.html
(checked 2026-10). Job API: bedrock.create_evaluation_job (applicationType=RagEvaluation,
precomputedRagSourceConfig.retrieveAndGenerateSourceConfig).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from evals.judge.judge import expectations, guidance_index, product_rules
from evals.schema import Scenario

MAX_RECORDS = 1000
BUILTIN_METRICS = [
    "Builtin.Correctness",
    "Builtin.Completeness",
    "Builtin.Helpfulness",
    "Builtin.LogicalCoherence",
    "Builtin.Faithfulness",
    "Builtin.Harmfulness",
    "Builtin.Stereotyping",
]
MAX_CUSTOM_METRICS = 10
MAX_CUSTOM_PROMPT_CHARS = 5000
TERMINAL = {"Completed", "Failed", "Stopped"}

_SCALE_3 = [
    {"definition": "Not met", "value": {"floatValue": 0.0}},
    {"definition": "Partly met", "value": {"floatValue": 0.5}},
    {"definition": "Fully met", "value": {"floatValue": 1.0}},
]


def job_name(run_id: str, mode: str, suffix: str = "") -> str:
    """Bedrock job names: lowercase letters, digits and hyphens, max 63."""
    base = re.sub(r"[^a-z0-9-]+", "-", f"kc-eval-{run_id}-{mode}{suffix}".lower()).strip("-")
    base = re.sub(r"-{2,}", "-", base)
    return base[:63].rstrip("-")


def _flatten_conversation(turns: Sequence[Dict[str, Any]], upto: int) -> str:
    parts = []
    for turn in turns[:upto]:
        parts.append(f"Parent: {turn.get('user', '')}")
        parts.append(f"Assistant: {turn.get('response', '')}")
    parts.append(f"Parent: {turns[upto].get('user', '')}")
    return "\n".join(parts)


def reference_text(scenario: Scenario) -> str:
    flow = " ".join(f"{i + 1}. {s.step} {s.text}".strip() for i, s in enumerate(scenario.reference_flow))
    items = "\n".join(f"- {x}" for x in expectations(scenario))
    return (
        f"A good answer meets these expectations:\n{items}\n\n"
        f"The user story's reference conversation flow: {flow}"
    ).strip()


def record_for(scenario: Scenario, transcript: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    turns = transcript.get("turns") or []
    if not turns:
        return None
    idx = guidance_index(transcript)
    if idx is None:
        idx = len(turns) - 1
    final = turns[idx]
    if not final.get("response"):
        return None
    passages = [
        {"name": (s.get("title") or "source")[:200], "content": {"text": s.get("content") or s.get("title") or ""}}
        for s in final.get("sources") or []
        if s.get("content") or s.get("title")
    ]
    mode = transcript.get("mode") or "standard"
    return {
        "conversationTurns": [{
            "prompt": {"content": [{"text": _flatten_conversation(turns, idx)}]},
            "referenceResponses": [{"content": [{"text": reference_text(scenario)}]}],
            "output": {
                "text": final["response"],
                "modelIdentifier": "knowledge-compass",
                "knowledgeBaseIdentifier": f"knowledge-compass-{mode}",
                "retrievedPassages": {"retrievalResults": passages},
            },
        }]
    }


def build_datasets(scenarios: Dict[str, Scenario], transcripts: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """{mode: [records]} for transcripts whose scenario is known."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for t in transcripts:
        scenario = scenarios.get(t.get("story_id"))
        if scenario is None:
            continue
        rec = record_for(scenario, t)
        if rec is not None:
            out.setdefault(t.get("mode") or "standard", []).append(rec)
    for mode, records in out.items():
        if len(records) > MAX_RECORDS:
            raise ValueError(f"{mode}: {len(records)} records exceeds the {MAX_RECORDS}-prompt job limit")
    return out


def custom_metrics(judge_model: str) -> Dict[str, Any]:
    """Product-rule and criteria metrics (<= 10), sharing the direct judge's rubric text."""
    metrics = []
    for key, text in product_rules():
        metrics.append({
            "customMetricDefinition": {
                "name": f"kc-{key.replace('_', '-')}",
                "instructions": (
                    "You review replies from a family-support assistant for Inclusion Canada that helps parents "
                    "navigate inclusive education.\n"
                    f"Rate the response on this rule: {text}\n"
                    "Scoring guidelines:\n- Not met: the response breaks the rule\n"
                    "- Partly met: minor or borderline issue\n- Fully met: the response follows the rule\n\n"
                    "Here is the actual task:\nPrompt: {{prompt}}\nResponse: {{prediction}}"
                ),
                "ratingScale": _SCALE_3,
            }
        })
    metrics.append({
        "customMetricDefinition": {
            "name": "kc-acceptance-criteria",
            "instructions": (
                "You review replies from a family-support assistant for Inclusion Canada.\n"
                "The ground truth lists the expectations a good answer meets for this parent's situation.\n"
                "Rate how many of those expectations the response meets.\n"
                "Scoring guidelines:\n- Not met: few or none of the expectations\n"
                "- Partly met: some expectations, important ones missing\n- Fully met: all or nearly all expectations\n\n"
                "Here is the actual task:\nPrompt: {{prompt}}\nGround truth: {{ground_truth}}\nResponse: {{prediction}}"
            ),
            "ratingScale": _SCALE_3,
        }
    })
    metrics = metrics[:MAX_CUSTOM_METRICS]
    for m in metrics:
        if len(m["customMetricDefinition"]["instructions"]) > MAX_CUSTOM_PROMPT_CHARS:
            raise ValueError(f"custom metric {m['customMetricDefinition']['name']} prompt is too long")
    return {
        "customMetrics": metrics,
        "evaluatorModelConfig": {"bedrockEvaluatorModels": [{"modelIdentifier": judge_model}]},
    }


def job_request(name: str, role_arn: str, dataset_uri: str, output_uri: str, judge_model: str, mode: str) -> Dict[str, Any]:
    custom = custom_metrics(judge_model)
    metric_names = BUILTIN_METRICS + [m["customMetricDefinition"]["name"] for m in custom["customMetrics"]]
    return {
        "jobName": name,
        "jobDescription": f"Knowledge Compass eval harness ({mode} mode)",
        "roleArn": role_arn,
        "applicationType": "RagEvaluation",
        "evaluationConfig": {
            "automated": {
                "datasetMetricConfigs": [{
                    "taskType": "QuestionAndAnswer",
                    "dataset": {"name": f"kc-{mode}", "datasetLocation": {"s3Uri": dataset_uri}},
                    "metricNames": metric_names,
                }],
                "evaluatorModelConfig": {"bedrockEvaluatorModels": [{"modelIdentifier": judge_model}]},
                "customMetricConfig": custom,
            }
        },
        "inferenceConfig": {
            "ragConfigs": [{
                "precomputedRagSourceConfig": {
                    "retrieveAndGenerateSourceConfig": {"ragSourceIdentifier": f"knowledge-compass-{mode}"}
                }
            }]
        },
        "outputDataConfig": {"s3Uri": output_uri},
        "jobTags": [{"key": "Project", "value": "KC"}, {"key": "Purpose", "value": "eval-harness"}],
    }


def to_jsonl(records: Sequence[Dict[str, Any]]) -> bytes:
    return ("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n").encode("utf-8")


def collect_metric_scores(obj: Any, into: Optional[Dict[str, List[float]]] = None) -> Dict[str, List[float]]:
    """Walk job output JSON for {"metricName": ..., "result": <number>} entries."""
    into = {} if into is None else into
    if isinstance(obj, dict):
        name, result = obj.get("metricName"), obj.get("result")
        if isinstance(name, str) and isinstance(result, (int, float)) and not isinstance(result, bool):
            into.setdefault(name, []).append(float(result))
        for v in obj.values():
            collect_metric_scores(v, into)
    elif isinstance(obj, list):
        for v in obj:
            collect_metric_scores(v, into)
    return into


def summarize_scores(scores: Dict[str, List[float]]) -> Dict[str, Dict[str, Any]]:
    return {
        name: {"mean": round(sum(vals) / len(vals), 3), "count": len(vals)}
        for name, vals in sorted(scores.items()) if vals
    }


class BedrockEvaluation:
    def __init__(self, bedrock_client, s3_client, bucket: str, role_arn: str, judge_model: str,
                 sleep: Callable[[float], None] = time.sleep, log: Callable[[str], None] = print):
        self.bedrock = bedrock_client
        self.s3 = s3_client
        self.bucket = bucket
        self.role_arn = role_arn
        self.judge_model = judge_model
        self.sleep = sleep
        self.log = log

    def start(self, run_id: str, mode: str, records: Sequence[Dict[str, Any]], suffix: str = "") -> Dict[str, Any]:
        key = f"input/{run_id}/{mode}.jsonl"
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=to_jsonl(records), ContentType="application/jsonl")
        name = job_name(run_id, mode, suffix)
        request = job_request(
            name, self.role_arn, f"s3://{self.bucket}/{key}",
            f"s3://{self.bucket}/output/{run_id}/{mode}/", self.judge_model, mode,
        )
        arn = self.bedrock.create_evaluation_job(**request)["jobArn"]
        self.log(f"started Bedrock evaluation job {name} ({len(records)} records)")
        return {"mode": mode, "job_name": name, "job_arn": arn, "records": len(records),
                "output_prefix": f"output/{run_id}/{mode}/"}

    def status(self, job_arn: str) -> Dict[str, Any]:
        """Current status of an existing job (no waiting)."""
        job = self.bedrock.get_evaluation_job(jobIdentifier=job_arn)
        out = {"status": job.get("status")}
        if job.get("failureMessages"):
            out["failure_messages"] = job["failureMessages"]
        return out

    def wait(self, job_arn: str, poll_seconds: float = 60.0, timeout_seconds: float = 4 * 3600) -> Dict[str, Any]:
        waited = 0.0
        while True:
            job = self.bedrock.get_evaluation_job(jobIdentifier=job_arn)
            status = job.get("status")
            if status in TERMINAL:
                return {"status": status, "failure_messages": job.get("failureMessages") or []}
            if waited >= timeout_seconds:
                return {"status": "Timeout"}
            self.sleep(poll_seconds)
            waited += poll_seconds

    def results(self, output_prefix: str) -> Dict[str, Dict[str, Any]]:
        scores: Dict[str, List[float]] = {}
        token = None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": output_prefix}
            if token:
                kwargs["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kwargs)
            for obj in page.get("Contents") or []:
                key = obj["Key"]
                if not key.endswith((".jsonl", ".json")) or "/custom_metrics/" in key:
                    continue
                body = self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read().decode("utf-8", "replace")
                for line in body.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        collect_metric_scores(json.loads(line), scores)
                    except json.JSONDecodeError:
                        continue
            if not page.get("IsTruncated"):
                break
            token = page.get("NextContinuationToken")
        return summarize_scores(scores)
