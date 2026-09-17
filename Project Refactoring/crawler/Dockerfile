# Web crawler ECS Fargate task image.
#
# IMPORTANT: build from the `Project Refactoring/` directory so the shared
# `common/` package is in the build context:
#
#   docker build -f crawler/Dockerfile -t kc-crawler "Project Refactoring"
#
# Uses the official Playwright Python image, which ships a matching Chromium +
# system dependencies (avoids the 250MB Lambda limit; see crawler/README.md).
# Pin the Playwright image tag to the version compatible with the installed
# playwright package.
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

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
