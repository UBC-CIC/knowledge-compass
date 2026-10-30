# Dependency Management Guide

## Overview

This document explains where the Python dependencies of each deployed component come from, how they are pinned, and how to change them. Node.js dependencies (`cdk/`, `frontend/`) are locked by their `package-lock.json` files and updated with `npm`.

## Where Each Component Gets Its Python Packages

| Component | Location | How it is packaged | Pinned in |
|---|---|---|---|
| Text generation Lambda | `cdk/lambda/textGeneration/` | Plain zip asset; nothing is installed at deploy time | `requirements.txt` (records what ships, for local tests) |
| Knowledge base Lambda | `cdk/lambda/knowledgeBase/` | Plain zip asset with `pypdf` and `python-docx` vendored into the folder as prebuilt wheels | `requirements.txt` |
| Crawler container | `cdk/containers/crawler/` | Docker image built by CodePipeline (Playwright base image) | `requirements.txt` (exact pins) |
| Transcriber container | `cdk/containers/transcriber/` | Docker image built by CodePipeline (`python:3.12-slim`) | `requirements.txt` (exact pins) |
| Evaluation harness | `evals/` | Local virtualenv | `requirements.txt` (exact pins) |

Shared sources for both Python Lambdas:

| Source | Provides | Notes |
|---|---|---|
| Lambda Python 3.12 runtime | `boto3` | Version is set by AWS |
| `cdk/layers/psycopg2.zip` (`psycopgLambdaLayer`) | `psycopg2` 2.9.11 | Bump `psycopg2-binary` in `textGeneration/requirements.txt` only together with a rebuilt layer zip |
| AWS Lambda Powertools layer (text generation only) | `aws_lambda_powertools` | Public layer ARN pinned in `cdk/lib/api-stack.ts` |
| `cdk/layers/shared_python/` (`sharedPythonLayer`) | `kc_shared` (CORS, embeddings, retrieval core, eval scoring, golden questions) | Project code, not third-party packages; imported as `kc_shared.*` |

The containers cannot use a Lambda layer, so they keep their own copy of `embeddings.py` and `url_safety.py` in `cdk/containers/common/`. The pipeline's unit-test stage fails if those copies drift from the layer or the knowledge base Lambda.

## Changing Dependencies

### Crawler or transcriber container

1. Edit the exact pin in `cdk/containers/<crawler|transcriber>/requirements.txt`. For the crawler, `playwright` must match the Playwright base image tag in its `Dockerfile`; change both together.
2. Check the resolved set for known vulnerabilities, for example with `pip-audit -r requirements.txt`.
3. Commit and push. CodePipeline runs the unit tests, rebuilds the image, scans it (a CRITICAL or HIGH finding blocks the build), and tags it `latest`. New ECS tasks pick up the new image.

Transitive dependencies are not pinned; each image build resolves them fresh.

### Knowledge base Lambda (`pypdf`, `python-docx`)

These are vendored so that deploying the Api stack never needs Docker. To change a version:

1. Update the pin in `cdk/lambda/knowledgeBase/requirements.txt`.
2. From the repo root, install the prebuilt wheel into the Lambda folder (works on any OS):

   ```bash
   pip install --platform manylinux2014_x86_64 --implementation cp \
     --python-version 3.12 --abi cp312 --only-binary=:all: --no-compile \
     --target cdk/lambda/knowledgeBase <package>==<version>
   ```

3. Delete the old version's `*.dist-info` folder, then commit the package folders and the new `*.dist-info`.
4. Redeploy the Api stack.

### Text generation Lambda

The Lambda has no packages of its own. To add one, either put it in a layer (as `psycopg2` is) or vendor it into the folder the same way as the knowledge base Lambda, then record the version in `requirements.txt`.

### Evaluation harness

Edit the exact pins in `evals/requirements.txt` and reinstall into the virtualenv:

```bash
py -m venv evals/.venv
evals/.venv/Scripts/python -m pip install -r evals/requirements.txt
```

## Tests in the Pipeline

The CICD stack's unit-test stage runs before any image is built. It installs only `boto3` and runs the CDK contract tests, the Node.js handler tests, both Python Lambda test suites, and the container tests (heavy dependencies stubbed). A dependency change that breaks an import fails here.
