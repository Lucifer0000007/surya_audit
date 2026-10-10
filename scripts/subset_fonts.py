"""Subset the two inlined Indic fonts to the glyphs the page's own text needs, and prove the shaping is unchanged.

Run by scripts/build_fonts.sh (it supplies fontTools, brotli and uharfbuzz through uv). Usage:
    python scripts/subset_fonts.py <page.html> <font dir> <runs dir>

Why not "subset by characters": for Devanagari, fontTools keeps every conjunct glyph that any pair of the kept
letters could form (496 glyphs), but the page writes only a few hundred distinct words. Here HarfBuzz shapes each
word the browser will shape (a run of characters inside the font's unicode-range), and every glyph seen at any step
of that shaping is kept; layout closure is switched off, so the font ships only the substitutions those words use.
The script then shapes every word again with the pruned font and fails unless the result is identical, glyph for
glyph, to the full font's. A word the page gains later needs a rebuild: tests/test_loop.py fails until the word is
in the runs file written here.
"""

import re
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools import subset
from fontTools.ttLib import TTFont

FONTS = {
    "deva": {"ttf": "NotoSansDevanagari-Regular.ttf", "pattern": "[ऀ-ॿ꣠-ꣿ]+", "script": "Deva", "language": "hi"},
    "guru": {"ttf": "NotoSansGurmukhi-Regular.ttf", "pattern": "[਀-੿]+", "script": "Guru", "language": "pa"},
}


def shape(font, text, script, language, seen=None):
    buf = hb.Buffer()
    buf.add_str(text)
    buf.script, buf.language = script, language
    buf.direction = "ltr"
    if seen is not None:
        def note(message):
            if message.startswith(("start lookup", "end lookup")):  # earlier steps still hold characters, not glyphs
                seen.update(info.codepoint for info in buf.glyph_infos)  # the glyphs in the buffer at this step
            return True
        buf.set_message_func(note)
    hb.shape(font, buf, {})
    if seen is not None:
        seen.update(info.codepoint for info in buf.glyph_infos)
    return [(i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset) for i, p in zip(buf.glyph_infos, buf.glyph_positions)]


def build(ttf_path, chars, glyph_names, flavor):
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.layout_closure = False  # keep only the substitutions between glyphs that are kept
    opts.hinting = False
    opts.desubroutinize = True
    opts.notdef_outline = True
    opts.glyph_names = flavor is None  # names only for the verification copy
    opts.flavor = flavor
    font = subset.load_font(str(ttf_path), opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in chars], glyphs=glyph_names)
    sub.subset(font)
    return font, opts


def main(page_path, font_dir, runs_dir):
    page = Path(page_path).read_text(encoding="utf-8")
    failures = 0
    for name, spec in FONTS.items():
        ttf = Path(font_dir) / spec["ttf"]
        runs = sorted(set(re.findall(spec["pattern"], page)))
        (Path(runs_dir) / f"{name}.runs.txt").write_text("\n".join(runs) + "\n", encoding="utf-8", newline="\n")
        chars = sorted({c for r in runs for c in r})
        full = TTFont(str(ttf))
        order = full.getGlyphOrder()
        hb_full = hb.Font(hb.Face(hb.Blob.from_file_path(str(ttf))))

        seen = set()
        reference = {r: shape(hb_full, r, spec["script"], spec["language"], seen) for r in runs}
        cmap = full.getBestCmap()
        wanted = seen | {0} | {full.getGlyphID(cmap[ord(c)]) for c in chars if ord(c) in cmap}
        names = [order[g] for g in sorted(wanted)]

        verify_font, opts = build(ttf, chars, names, None)
        pruned_order = verify_font.getGlyphOrder()
        tmp = Path(runs_dir) / f".{name}.verify.ttf"
        subset.save_font(verify_font, str(tmp), opts)
        hb_small = hb.Font(hb.Face(hb.Blob.from_file_path(str(tmp))))
        bad = []
        for r in runs:
            got = [(pruned_order[g], c, a, x, y) for g, c, a, x, y in shape(hb_small, r, spec["script"], spec["language"])]
            want = [(order[g], c, a, x, y) for g, c, a, x, y in reference[r]]
            if got != want:
                bad.append(r)
        tmp.unlink()
        if bad:
            failures += 1
            print(f"{name}: SHAPING DIFFERS for {len(bad)} of {len(runs)} words, e.g. {bad[:5]}", file=sys.stderr)
            continue

        ship, opts = build(ttf, chars, names, "woff2")
        out = Path(font_dir) / f"{name}.woff2"
        subset.save_font(ship, str(out), opts)
        print(f"{name}: {len(runs)} words, {len(chars)} characters, {len(names)} of {len(order)} glyphs, {out.stat().st_size} bytes; shaping identical for every word")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
