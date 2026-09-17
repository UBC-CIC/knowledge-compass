# Video transcript ingestor image (ECS Fargate task or container Lambda).
#
# IMPORTANT: build from the `Project Refactoring/` directory so the shared
# `common/` package is in the build context:
#
#   docker build -f transcriber/Dockerfile -t kc-transcriber "Project Refactoring"
#
# Lightweight: no browser needed (unlike the crawler). Only psycopg2 + boto3.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY transcriber/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Fetch the RDS CA bundle at build time for verify-full TLS.
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '/app/global-bundle.pem')"
ENV DB_SSL_ROOT_CERT=/app/global-bundle.pem

COPY common/ ./common/
COPY transcriber/transcrbe.py ./transcrbe.py

# Non-root user.
RUN useradd --create-home appuser
USER appuser

# The ingestion-trigger supplies work via env vars: JOB_ID, TRANSCRIPT_JSON,
# VIDEO_URL, VIDEO_NAME, WRITE_DB, SEMANTIC. DB config via env (DB_AUTH=secret).
ENTRYPOINT ["python", "transcrbe.py"]
