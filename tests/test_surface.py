"""Lints of the page against the user's surface rules.

Text checks over `app/index.html`: a rule of the surface upgrade is kept by a test, not by memory. They read the page; they
never change it.
"""

import re
from pathlib import Path

PAGE = (Path(__file__).resolve().parent.parent / "app" / "index.html").read_text(encoding="utf-8")
STYLE = re.search(r"<style>(.*?)</style>", PAGE, re.S).group(1)
REST = PAGE.replace(STYLE, "")  # the markup and the script


def rules(css):
    """Every innermost `selector { declarations }` block, with comments dropped (the @media wrappers are not rules)."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css)]


def test_no_text_in_the_page_is_set_under_14px():
    """Minimum text is 0.875rem (14 px). Sizes are in rem or px; anything relative to the parent (em, %) could shrink
    below the floor unseen, so it is refused, except the root size that the "A+" button raises above 100%.

    The lint reads every `font-size` of the stylesheet and of inline `style=""` attributes. It fails closed: every mention
    of `font-size` or `fontSize` anywhere in the page must be one it parsed, so a size written in another form (a keyword,
    calc(), clamp(), var(), a script property such as `style.fontSize` or `setProperty`, an SVG attribute) is refused, and so
    is the `font` shorthand, in the stylesheet and in the script."""
    css = re.sub(r"/\*.*?\*/", "", STYLE, flags=re.S)
    blocks = rules(STYLE) + [("[style]", m) for m in re.findall(r'style="([^"]*)"', REST)]
    seen, too_small = 0, []
    for selector, body in blocks:
        for value, unit in re.findall(r"font-size:\s*([0-9.]+)(rem|px|em|%)", body):
            seen += 1
            if unit == "%" and re.fullmatch(r"(html|:root)(\[[^\]]+\])?", selector) and float(value) >= 100:
                continue
            px = float(value) * 16 if unit == "rem" else float(value) if unit == "px" else None
            if px is None or px < 14:
                too_small.append(f"{selector}: {value}{unit}")
    assert seen > 20, "too few font sizes found: the lint is not looking at the stylesheet"
    assert too_small == []
    mentions = len(re.findall(r"font-?size", css + REST, re.I))
    assert mentions == seen, f"{mentions - seen} mention(s) of font-size are in a form this lint cannot read: use rem or px, in the stylesheet or an inline style attribute"
    shorthand = [v.strip() for v in re.findall(r"(?:^|[;{\s])font\s*:\s*([^;}\"']*)", css + REST)]
    assert [v for v in shorthand if v not in ("inherit", "initial", "unset", "revert")] == [], "the font shorthand sets a size this lint cannot see: use font-family and font-size"
    assert re.findall(r"style\.font\s*=|setProperty\(\s*['\"]font['\"]", REST) == [], "a script sets the font shorthand: use font-size in rem or px"


def test_the_page_uses_the_user_wording_for_co2_and_never_shows_litres():
    """The impact strip says "avoided grid CO2", never "emissions saved" or "CO2 lost", and shows "cleanings avoided", never
    litres of water (no sourced figure exists for them)."""
    lowered = PAGE.lower()
    for banned in ("emissions saved", "co₂ lost", "co2 lost", "lost co", "litre", "liter", "लीटर", "ਲੀਟਰ"):
        assert banned not in lowered, banned
    assert "avoided grid CO₂" in PAGE and "Cleanings avoided" in PAGE
