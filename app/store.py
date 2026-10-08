"""Site storage. In-memory for local runs and tests; DynamoDB replaces it at deployment."""

import copy
import threading


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
            self._sites[site["id"]] = copy.deepcopy(site)
