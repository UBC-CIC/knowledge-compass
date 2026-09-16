import json
import os

import boto3

lambda_client = boto3.client("lambda")
TARGET = os.environ["TARGET_FUNCTION_NAME"]


def handler(event, context):
    lambda_client.invoke(
        FunctionName=TARGET,
        InvocationType="Event",
        Payload=json.dumps(event).encode("utf-8"),
    )
    return {"ok": True}
