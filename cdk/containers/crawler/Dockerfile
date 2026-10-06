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
# playwright package (keep in sync with playwright== in requirements.txt).
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

# Chromium's user-namespace sandbox is unavailable on Fargate (and in default
# Docker), so the browser fails to launch with "No usable sandbox". Isolation
# comes from the container boundary plus the non-root pwuser instead.
ENV CRAWLEE_DISABLE_BROWSER_SANDBOX=true

WORKDIR /app

# Install Python deps first for better layer caching.
COPY crawler/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

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
