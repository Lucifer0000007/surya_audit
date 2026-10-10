#!/usr/bin/env python3
"""Fail if a protected path differs from the last deployed commit (docs/FROZEN_SHA).

The surface upgrade may change the page, its screen checks and its docs, never the engine, the API,
the infrastructure or their tests. docs/PROTECTED_PATHS lists the paths (git pathspecs).
tests/test_loop.py is protected except the page tests named in PAGE_TESTS.

Usage: python scripts/check_frozen.py [REV]    (REV defaults to docs/FROZEN_SHA)
Prints one line and exits 0 when nothing protected changed, otherwise prints what changed and exits 1.
"""
import ast
import difflib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUARDED_TEST_FILE = "tests/test_loop.py"
PAGE_TESTS = {"test_page_is_served_self_contained", "test_indic_font_subsets_cover_the_page"}
SIZE_LINE = re.compile(r"^(- `app/index.html` stays under )\d+( KB, inlined fonts included\.)$")  # the one CLAUDE.md line the user let v4 change


def same_but_size_line(a, b):
    """True when two CLAUDE.md texts are equal once the page size limit is ignored."""
    norm = lambda text: [SIZE_LINE.sub(r"N", line) for line in text.splitlines()]
    return norm(a) == norm(b)


def git(*args):
    done = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if done.returncode != 0:
        sys.exit(f"git {args[0]} failed: {done.stderr.strip()[:160]}")
    return done.stdout


def entries(name):
    text = (ROOT / name).read_text(encoding="utf-8-sig")  # a byte-order mark must not hide the first line
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def without_page_tests(source):
    """The file's lines with the page tests removed, and the names of the page tests it has."""
    drop, found = set(), set()
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name in PAGE_TESTS:
            found.add(node.name)
            first = min([node.lineno] + [d.lineno for d in node.decorator_list])
            drop.update(range(first, node.end_lineno + 1))
    return [line for number, line in enumerate(source.splitlines(), 1) if number not in drop], found


def main(argv):
    if len(argv) > 1:
        rev = argv[1]
    else:
        listed = entries("docs/FROZEN_SHA")
        if len(listed) != 1 or not re.fullmatch(r"[0-9a-f]{40}", listed[0]):
            sys.exit("docs/FROZEN_SHA must hold one full 40-character commit hash")
        rev = listed[0]
    sha = git("rev-parse", "--verify", rev + "^{commit}").strip()
    paths = entries("docs/PROTECTED_PATHS")
    if not paths:
        sys.exit("docs/PROTECTED_PATHS lists no paths")

    changed = set(git("diff", "--name-only", sha, "--", *paths).split())  # working tree against the frozen commit
    if "CLAUDE.md" in changed and same_but_size_line((ROOT / "CLAUDE.md").read_text(encoding="utf-8"), git("show", f"{sha}:CLAUDE.md")):
        changed.discard("CLAUDE.md")  # only the size line moved, as the user authorised
    changed |= set(git("diff", "--cached", "--name-only", sha, "--", *paths).split())  # staged, even if the file was put back
    changed |= set(git("ls-files", "--others", "--exclude-standard", "--", *paths).split())  # new and untracked
    unmatched = [p for p in paths if not git("ls-files", "--", p).split()]  # a pattern that matches nothing protects nothing
    if unmatched:
        print("docs/PROTECTED_PATHS has patterns that match no tracked file (mistyped, or the last file was removed): " + ", ".join(unmatched))
        return 1

    now = (ROOT / GUARDED_TEST_FILE).read_text(encoding="utf-8")
    then = git("show", f"{sha}:{GUARDED_TEST_FILE}")
    kept_now, found = without_page_tests(now)
    kept_then, _ = without_page_tests(then)
    if found != PAGE_TESTS:
        changed.add(f"{GUARDED_TEST_FILE} (missing page test {sorted(PAGE_TESTS - found)[0]})")
    elif kept_now != kept_then:
        diff = [d for d in difflib.unified_diff(kept_then, kept_now, lineterm="", n=0) if d[:1] in "+-" and d[:3] not in ("+++", "---")]
        changed.add(f"{GUARDED_TEST_FILE} outside its two page tests (first change: {diff[0][:60].strip()})")

    if changed:
        print(f"protected paths differ from {sha[:7]}: " + ", ".join(sorted(changed)))
        return 1
    print(f"frozen: {len(paths)} protected patterns and {GUARDED_TEST_FILE} (outside {len(PAGE_TESTS)} page tests) match {sha[:7]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
