# Web crawler ECS Fargate task image.
#
# IMPORTANT: build from the `cdk/containers/` directory so the shared
# `common/` package is in the build context:
#
#   docker build -f crawler/Dockerfile -t kc-crawler cdk/containers
#
# Uses the official Playwright Python image, which ships a matching Chromium +
# system dependencies (avoids the 250MB Lambda limit; see crawler/README.md).
# Pin the Playwright image tag to the version compatible with the installed
# playwright package (keep in sync with playwright== in requirements.in).
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Pull current Ubuntu security fixes so the ECR scan gate (blocks on CRITICAL)
# doesn't fail on CVEs patched after the base image was published.
# Also purge the system ffmpeg (libav*) and cjson libraries: they carry
# unpatched CRITICAL CVEs and are only used by the WebKit/GStreamer media stack.
# Chromium bundles its own media codecs, so the crawler doesn't need them.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && PURGE="$(dpkg-query -W -f='${Package} ${source:Package}\n' \
         | awk '$2=="ffmpeg" || $2=="cjson" {print $1}')" \
    && if [ -n "$PURGE" ]; then apt-get purge -y --auto-remove $PURGE; fi \
    && rm -rf /var/lib/apt/lists/*

# Crawlee defaults to ./storage (i.e. /app/storage), which the non-root pwuser
# cannot create in the root-owned /app. Point it at a writable tmp path.
ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee-storage

# Chromium's sandbox cannot start on Fargate: the namespace sandbox needs
# unprivileged user namespaces or CAP_SYS_ADMIN, the setuid fallback also needs
# CLONE_NEW* namespaces, Fargate only allows adding SYS_PTRACE, and it does not
# support custom seccomp profiles. Removing this makes every launch fail with
# "No usable sandbox". This browser renders untrusted pages, so compensating
# controls are: the non-root pwuser (below), the request-level SSRF guard in
# crawler.py / common/url_safety.py (only public http(s) hosts are fetched),
# and the task security group limiting public egress to 443.
# readonlyRootFilesystem is deferred: it needs a task-definition change, which
# is blocked while KC-Api imports the task-def ARN export (ingestion-stack.ts),
# and Fargate has no tmpfs for the writable /tmp Chromium needs.
ENV CRAWLEE_DISABLE_BROWSER_SANDBOX=true

WORKDIR /app

# Install Python deps first for better layer caching. requirements.txt is the
# fully pinned, hashed lock generated from requirements.in.
COPY crawler/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# Chromium is preinstalled in the base image; ensure the browser matching the
# pinned playwright package is present (no-op if already installed).
RUN python -m playwright install chromium

# DB_HOST is the RDS Proxy endpoint, not the RDS instance directly. RDS Proxy
# serves an ACM-issued certificate (not an rds-ca-* one), so verify-full must
# check it against the OS trust store, not the RDS CA bundle.
ENV DB_SSL_ROOT_CERT=/etc/ssl/certs/ca-certificates.crt

# App code: shared config package + crawler.
COPY common/ ./common/
COPY crawler/crawler.py ./crawler.py

# Non-root for defense in depth (base image provides the 'pwuser' account).
USER pwuser

# The proxy Lambda supplies work via env vars: JOB_ID, SEED_URL, MAX_PAGES,
# WRITE_DB, SEMANTIC. DB config (DB_HOST/DB_NAME/DB_USER, DB_AUTH=secret) also via env.
ENTRYPOINT ["python", "crawler.py"]
