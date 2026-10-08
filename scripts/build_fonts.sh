#!/usr/bin/env bash
# Rebuilds the two inlined Indic font subsets in app/index.html from the characters the page uses.
# Run as `bash scripts/build_fonts.sh` after changing Hindi or Punjabi text: tests/test_loop.py fails
# when the page uses a character the subsets lack. Fonts, licence and rationale: SOURCES.md ("Fonts").
# Needs curl (first run downloads the two Noto TTFs) and uv (pyftsubset runs through uvx, pinned).
set -euo pipefail
cd "$(dirname "$0")/.."
PAGE=${PAGE:-app/index.html}
FONT_DIR=${FONT_DIR:-.claude/fonts.local}   # ignored by git; the TTFs are 220 KB and re-downloadable
LISTS=fixtures/fonts                          # the character lists the subsets were built from (committed)
mkdir -p "$FONT_DIR" "$LISTS"
PY=.venv/Scripts/python.exe; [ -x "$PY" ] || PY=.venv/bin/python; [ -x "$PY" ] || PY=python

BASE=https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts
for f in NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Regular.ttf NotoSansGurmukhi/unhinted/ttf/NotoSansGurmukhi-Regular.ttf; do
  [ -f "$FONT_DIR/$(basename "$f")" ] || curl -sfL -o "$FONT_DIR/$(basename "$f")" "$BASE/$f"
done

# 1. The characters the page uses, per script, plus the digits and punctuation that sit inside Indic text.
"$PY" -I - "$PAGE" "$LISTS" <<'PYEOF'
import sys
page = open(sys.argv[1], encoding="utf-8").read()
common = " .,:;!?()%/-0123456789‘’“”…–₹ "  # no trailing newline: pyftsubset would subset U+000A too
deva = sorted({c for c in page if 0x0900 <= ord(c) <= 0x097F or 0xA8E0 <= ord(c) <= 0xA8FF})
guru = sorted({c for c in page if 0x0A00 <= ord(c) <= 0x0A7F})
for name, chars in (("deva", deva), ("guru", guru)):
    with open(f"{sys.argv[2]}/{name}.txt", "w", encoding="utf-8", newline="\n") as f:
        f.write("".join(chars) + common)
    print(f"{name}: {len(chars)} characters")
PYEOF

# 2. Subset (fontTools and brotli pinned to the versions recorded in SOURCES.md). --layout-features='*'
#    keeps the OpenType shaping features Indic scripts need.
for pair in "NotoSansDevanagari-Regular:deva" "NotoSansGurmukhi-Regular:guru"; do
  ttf=${pair%%:*}; name=${pair##*:}
  uvx --from 'fonttools==4.66.1' --with 'brotli==1.2.0' pyftsubset "$FONT_DIR/$ttf.ttf" \
    --text-file="$LISTS/$name.txt" --layout-features='*' --flavor=woff2 --no-hinting --desubroutinize \
    --output-file="$FONT_DIR/$name.woff2"
done

# 3. Splice the new base64 payloads into the page's two @font-face rules (matched by unicode-range).
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
