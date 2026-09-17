# Retrieval comparison harness (R9)

`compare_retrieval.py` runs a fixed query set through **both** retrieval backends
(Bedrock Knowledge Base vs pgvector) and reports how they compare, so cutover
acceptance thresholds (plan §6.2, §8 item 5) can be set with real numbers.

## What it measures (per query + aggregate)
- retrieval latency and generation latency (ms)
- number of sources returned
- top-k source URLs, and the **URL overlap** between the two backends (Jaccard)
- a grounded answer per backend, scored by the production
  `intervention.assess_response` -> `score` + `label`
  (grounded / partially_grounded / unsupported)

## This is a LIVE tool
It calls Bedrock, the Bedrock KB, and RDS/pgvector. Run it where AWS creds + DB
access exist (e.g. the SageMaker instance or a VPC bastion), not in CI. It reuses
the production Lambda helpers in `cdk/lambda/textGeneration/helpers` and the shared
`../common/db_config.py` for DB access — no credentials in source.

## Prereqs
- Migrations 001/002 applied; a representative corpus loaded into `sources`/`chunks`.
- `pip install boto3 psycopg2-binary`
- DB env for the pgvector backend (see `../common/db_config.py`):
  `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_AUTH=iam` (or `secret`/`password`), TLS vars.

## Run
```bash
# both backends
export KB_ID=<bedrock-kb-id> REGION=ca-central-1
export DB_HOST=... DB_NAME=KC DB_USER=app_rw DB_AUTH=iam DB_SSL_ROOT_CERT=./global-bundle.pem
python compare_retrieval.py --backends both --top-k 7 --min-score 0.40

# pgvector only (once KB is being retired)
python compare_retrieval.py --backends pgvector

# custom query set
python compare_retrieval.py --queries my_queries.json --output my_results.json
```

## Interpreting results
- **Cutover is safe** when, on the agreed query set, pgvector's `mean_score` and
  label mix are >= Bedrock's (or within an agreed tolerance), latency is acceptable,
  and out-of-scope probes are declined by both.
- Record the numbers you accept as the thresholds in plan §8 item 5 before flipping
  `USE_PGVECTOR_RETRIEVAL=true` in production.

## Query set
`comparison_queries.json` seeds a set derived from the Inclusion Canada user-story
stages plus out-of-scope probes. Expand it with real family questions before relying
on the thresholds.
