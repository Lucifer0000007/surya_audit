"""The Gemini key: GEMINI_API_KEY locally, an SSM Parameter Store SecureString when deployed.

GEMINI_KEY_PARAM names the parameter; it is read once per Lambda container and never logged.
If it cannot be read (not created yet, no permission), photo reading is simply unavailable
and the owner types the reading by hand.
"""

import logging
import os

log = logging.getLogger(__name__)
_cached: str | None = None


def gemini_key() -> str | None:
    global _cached
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    param = os.environ.get("GEMINI_KEY_PARAM")
    if not param:
        return None
    if _cached is None:
        import boto3  # only needed when deployed
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            _cached = boto3.client("ssm").get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"]
        except ClientError as e:
            log.warning("Gemini key parameter could not be read (%s); photo reading is off",
                        e.response.get("Error", {}).get("Code", "ClientError"))
            return None
        except BotoCoreError as e:
            log.warning("Gemini key parameter could not be read (%s); photo reading is off", e.__class__.__name__)
            return None
    return _cached
