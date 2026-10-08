"""Site storage: in memory for local runs and tests, DynamoDB when SITES_TABLE is set (deployed).

Each site is one JSON document with a version number. A save only succeeds if nobody saved
the site since it was read (the daily weather refresh and an owner's save can race), otherwise
it raises StoreConflict and the caller asks the owner to try again.
"""

import copy
import json
import os
import threading


class StoreConflict(Exception):
    """The site changed since it was read."""


class MemoryStore:
    def __init__(self) -> None:
        self._sites: dict[str, dict] = {}
        self._lock = threading.Lock()

    def get(self, site_id: str) -> dict | None:
        with self._lock:
            site = self._sites.get(site_id)
            return copy.deepcopy(site) if site else None

    def put(self, site: dict) -> None:
        with self._lock:
            stored = self._sites.get(site["id"])
            if (stored["version"] if stored else 0) != site.get("version", 0):
                raise StoreConflict(site["id"])
            site["version"] = site.get("version", 0) + 1
            self._sites[site["id"]] = copy.deepcopy(site)

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._sites)


class DynamoStore:
    """One item per site: {"id": <site id>, "version": <n>, "doc": <site JSON>}."""

    def __init__(self, table_name: str) -> None:
        import boto3  # only needed when deployed

        self._table = boto3.resource("dynamodb").Table(table_name)

    def get(self, site_id: str) -> dict | None:
        item = self._table.get_item(Key={"id": site_id}, ConsistentRead=True).get("Item")
        if item is None:
            return None
        site = json.loads(item["doc"])
        site["version"] = int(item["version"])
        return site

    def put(self, site: dict) -> None:
        from botocore.exceptions import ClientError

        version = site.get("version", 0)
        doc = {k: v for k, v in site.items() if k != "version"}
        try:
            self._table.put_item(
                Item={"id": site["id"], "version": version + 1, "doc": json.dumps(doc, separators=(",", ":"))},
                ConditionExpression="attribute_not_exists(#id) OR #v = :v",
                ExpressionAttributeNames={"#id": "id", "#v": "version"},
                ExpressionAttributeValues={":v": version},
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise StoreConflict(site["id"]) from e
            raise
        site["version"] = version + 1

    def ids(self) -> list[str]:
        ids, kwargs = [], {"ProjectionExpression": "#id", "ExpressionAttributeNames": {"#id": "id"}}
        while True:
            page = self._table.scan(**kwargs)
            ids += [item["id"] for item in page.get("Items", [])]
            if "LastEvaluatedKey" not in page:
                return ids
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def make_store() -> MemoryStore | DynamoStore:
    table = os.environ.get("SITES_TABLE")
    return DynamoStore(table) if table else MemoryStore()
