# Dependency Management Guide

## Overview

This document explains where the Python dependencies of each deployed component come from, how they are pinned, and how to change them. Node.js dependencies (`cdk/`, `frontend/`) are locked by their `package-lock.json` files and updated with `npm`.

## Where Each Component Gets Its Python Packages

| Component | Location | How it is packaged | Pinned in |
|---|---|---|---|
| Text generation Lambda | `cdk/lambda/textGeneration/` | Plain zip asset; nothing is installed at deploy time | `requirements.txt` (records what ships, for local tests) |
| Knowledge base Lambda | `cdk/lambda/knowledgeBase/` | Plain zip asset with `pypdf` and `python-docx` vendored into the folder as prebuilt wheels | `requirements.in` (direct), `requirements.txt` (full lock with hashes) |
| Crawler container | `cdk/containers/crawler/` | Docker image built by CodePipeline (Playwright base image) | `requirements.in` (direct), `requirements.txt` (full lock with hashes) |
| Transcriber container | `cdk/containers/transcriber/` | Docker image built by CodePipeline (`python:3.12-slim`) | `requirements.in` (direct), `requirements.txt` (full lock with hashes) |
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

### How the locks work

The crawler, the transcriber and the knowledge base Lambda each have two files:

- `requirements.in` lists only the direct dependencies, with exact pins. This is the file you edit.
- `requirements.txt` is generated from it by [uv](https://docs.astral.sh/uv/) (`uv pip compile`). It pins every transitive dependency too, with SHA-256 hashes for every wheel of each pinned version. Do not edit it by hand.

The lock is resolved for the deployed target, not for the machine running the command: Python 3.12 on x86_64 Linux (the Lambdas set no `architecture` and the ECS task definitions set no `runtimePlatform`, so both run on x86_64). Each generated file's header records the exact command that produced it. Re-running that command with no `requirements.in` change gives no diff, unless a newer release of an unpinned name appeared; pass `--upgrade-package <name>` to move one transitive package on purpose.

### Crawler or transcriber container

1. Edit the exact pin in `cdk/containers/<crawler|transcriber>/requirements.in`. For the crawler, `playwright` must match the Playwright base image tag in its `Dockerfile`; change both together.
2. Regenerate the lock from the repo root:

   ```bash
   uv pip compile cdk/containers/crawler/requirements.in \
     -o cdk/containers/crawler/requirements.txt --generate-hashes \
     --python-version 3.12 --python-platform x86_64-manylinux_2_28

   uv pip compile cdk/containers/transcriber/requirements.in \
     -o cdk/containers/transcriber/requirements.txt --generate-hashes \
     --python-version 3.12 --python-platform x86_64-manylinux_2_28
   ```

   `manylinux_2_28` is below the glibc of both base images (`python:3.12-slim` is Debian 12, glibc 2.36; the Playwright `noble` image is Ubuntu 24.04, glibc 2.39).
3. Check the resolved set for known vulnerabilities, for example with `pip-audit -r requirements.txt`.
4. Commit both files and push. The Dockerfiles install with `pip install --require-hashes -r requirements.txt`, so a package missing from the lock or a wheel whose hash does not match fails the build. CodePipeline runs the unit tests, rebuilds the image, scans it (a CRITICAL or HIGH finding blocks the build), and tags it `latest`. New ECS tasks pick up the new image.

### Knowledge base Lambda (`pypdf`, `python-docx`)

These are vendored so that deploying the Api stack never needs Docker. `requirements.in` also pins their transitive dependencies `lxml` and `typing_extensions` to the vendored versions. To change a version:

1. Update the pin in `cdk/lambda/knowledgeBase/requirements.in`.
2. From the repo root, regenerate the lock (`manylinux2014` matches the vendoring command below):

   ```bash
   uv pip compile cdk/lambda/knowledgeBase/requirements.in \
     -o cdk/lambda/knowledgeBase/requirements.txt --generate-hashes \
     --python-version 3.12 --python-platform x86_64-manylinux2014
   ```

3. Delete the old version's package folder and `*.dist-info` folder, then install the prebuilt wheels into the Lambda folder (works on any OS):

   ```bash
   pip install --platform manylinux2014_x86_64 --implementation cp \
     --python-version 3.12 --abi cp312 --only-binary=:all: --no-compile \
     --no-deps --require-hashes --target cdk/lambda/knowledgeBase \
     -r cdk/lambda/knowledgeBase/requirements.txt
   ```

4. Run `py -3 -m unittest discover -s tests` in `cdk/lambda/knowledgeBase`. `tests/test_vendored_requirements.py` fails if a pin has no matching vendored `*.dist-info` folder or a vendored package is not pinned.
5. Commit the lock, the package folders and the new `*.dist-info`, then redeploy the Api stack.

### Text generation Lambda

The Lambda has no packages of its own, so there is nothing transitive to pin: `boto3` comes from the runtime and `psycopg2` from the layer, which has no dependencies. To add one, either put it in a layer (as `psycopg2` is) or vendor it into the folder the same way as the knowledge base Lambda, then record the version in `requirements.txt`.

### Evaluation harness

Edit the exact pins in `evals/requirements.txt` and reinstall into the virtualenv:

```bash
py -m venv evals/.venv
evals/.venv/Scripts/python -m pip install -r evals/requirements.txt
```

## Tests in the Pipeline

The CICD stack's unit-test stage runs before any image is built. It installs only `boto3` (pinned in `cdk/lib/cicd-stack.ts`; test-only, so it is not part of any lock) and runs the CDK contract tests, the Node.js handler tests, both Python Lambda test suites, and the container tests (heavy dependencies stubbed). A dependency change that breaks an import fails here.
