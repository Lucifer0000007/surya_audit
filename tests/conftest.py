"""Tests stay offline: no deployed table, key parameter or key, even if the shell exports them.

This runs before any test module imports app.main, which picks its store from SITES_TABLE.
"""

import os

for name in ("SITES_TABLE", "GEMINI_KEY_PARAM", "GEMINI_API_KEY"):
    os.environ.pop(name, None)
