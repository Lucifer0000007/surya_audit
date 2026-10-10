#!/usr/bin/env bash
# Rebuilds the two inlined Indic fonts in app/index.html. They hold only the glyphs the page's own Hindi and
# Punjabi words need: scripts/subset_fonts.py shapes every word with HarfBuzz, keeps what that uses, and refuses to
# finish unless the pruned font shapes every word exactly like the full one. Run as `bash scripts/build_fonts.sh`
# after ANY change to Hindi or Punjabi text: tests/test_loop.py fails while the page has a word the fonts were not
# built from. Fonts, licence and rationale: SOURCES.md ("Fonts").
# Needs curl (the first run downloads the two Noto TTFs) and uv (fontTools, brotli and uharfbuzz run through
# `uv run --with`, pinned; they are build tools, not project dependencies).
set -euo pipefail
cd "$(dirname "$0")/.."
PAGE=${PAGE:-app/index.html}
FONT_DIR=${FONT_DIR:-.claude/fonts.local}   # ignored by git; the TTFs are 220 KB and re-downloadable
LISTS=${LISTS:-fixtures/fonts}              # the words the fonts were built from (committed; the test reads them)
mkdir -p "$FONT_DIR" "$LISTS"
PY=.venv/Scripts/python.exe; [ -x "$PY" ] || PY=.venv/bin/python; [ -x "$PY" ] || PY=python

BASE=https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts
for f in NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Regular.ttf NotoSansGurmukhi/unhinted/ttf/NotoSansGurmukhi-Regular.ttf; do
  [ -f "$FONT_DIR/$(basename "$f")" ] || curl -sfL -o "$FONT_DIR/$(basename "$f")" "$BASE/$f"
done

# 1. Subset to the words the page writes, and prove the shaping is unchanged (exits non-zero if it is not).
PYTHONIOENCODING=utf-8 uv run --no-project --with 'fonttools==4.66.1' --with 'brotli==1.2.0' --with 'uharfbuzz==0.56.3' \
  python scripts/subset_fonts.py "$PAGE" "$FONT_DIR" "$LISTS"

# 2. Splice the new base64 payloads into the page's two @font-face rules (matched by unicode-range).
"$PY" -I - "$PAGE" "$FONT_DIR" <<'PYEOF'
import base64, re, sys
path, font_dir = sys.argv[1], sys.argv[2]
page = open(path, encoding="utf-8", newline="").read()
for name, rng in (("deva", r"U\+0900-097F"), ("guru", r"U\+0A00-0A7F")):
    b64 = base64.b64encode(open(f"{font_dir}/{name}.woff2", "rb").read()).decode()
    pattern = re.compile(r"(unicode-range: " + rng + r"[^\n]*\n\s*src: url\(data:font/woff2;base64,)[A-Za-z0-9+/=]+")
    page, n = pattern.subn(lambda m: m.group(1) + b64, page)
    if n != 1:
        sys.exit(f"expected one @font-face rule for {name}, found {n}")
    print(f"{name}.woff2: {len(b64) * 3 // 4} bytes inlined")
open(path, "w", encoding="utf-8", newline="").write(page)
PYEOF
echo "done: $PAGE is $(wc -c < "$PAGE") bytes"
