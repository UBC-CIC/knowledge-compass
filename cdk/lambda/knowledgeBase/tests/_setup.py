"""
Shared test setup; import it before any `helpers` module.

- Makes `helpers` importable. Appended, not prepended: the knowledgeBase dir
  vendors linux-only wheels (lxml) for the Lambda, which must not shadow the
  local interpreter's own installs.
- Module-level boto3 clients need a region, and dummy credentials keep them
  from reading (or requiring plugins for) the developer's AWS config. Tests
  never call AWS.
- PDFs are read with pypdf only, whatever the developer's shell sets; tests
  of the Textract path (test_pdf_text.py) opt in per test with fake clients.
"""

import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

os.environ.setdefault("REGION", "us-east-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
os.environ.pop("AWS_PROFILE", None)
os.environ["PDF_TEXTRACT_MODE"] = "off"
os.environ.pop("KNOWLEDGE_BASE_BUCKET_NAME", None)
