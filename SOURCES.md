# Sources for the numbers the page shows

Every default the page uses as an **editable assumption** (a section marked REMOVED is no longer used by the page) is listed here with its source URL, what the source
says, and the date it was retrieved. The author re-fetched each source and checked the quoted figures on
2026-10-08 (two automated re-fetch passes per finding, see `LOOP_LOG.md`). Where a value is our own arithmetic
from a source, it says so. Vendor pages are labelled as such.

## Electricity tariff (default Rs 7 per unit)

- **CEA, "Electricity Tariff & Duty & Average rates of electricity supply in India", March 2026 edition**,
  Table 1(b) DOMESTIC 2 KW (200 units/month):
  `Uttar Pradesh (URBAN) 29.11.2025 673 34 706` → **Rs 7.06/kWh** including 5% duty; 100 units/month: Rs 6.93;
  400 units/month: Rs 7.39. Across all 49 utilities the 200-unit rate runs from Rs 2.20 to Rs 11.37.
  https://cea.nic.in/api/dashboardReports/view-pdf/en/a6bd09cf-72e4-4a30-8a37-a648ca22eaa6 (PDF pp. 166-169),
  retrieved 2026-10-08.
- **UPERC tariff order for FY 2026-27** (no hike; LMV-1 domestic: fixed Rs 110/kW/month, energy Rs 5.50 / 6.00 / 6.50
  per kWh for 0-150 / 151-300 / >300 units, 5% duty), via the Lucknow discom site mvvnl.in, retrieved 2026-10-08.
- How we use it: the demo site is Lucknow, so Rs 7 is a sourced default for UP. The value of one *lost* solar unit is
  the household's top-slab energy charge plus duty: Rs 5.78 / 6.30 / 6.83 per kWh (our arithmetic), so Rs 7
  slightly overstates the loss. Outside UP the owner should edit it; the page labels it an assumption either way.

## Grid CO2 emission factor (default 0.675 kg CO2 per kWh)

- **CEA, "CO2 Baseline Database for the Indian Power Sector", User Guide Version 22.0, August 2026**:
  weighted average emission factor of the grid, FY 2025-26, **0.675 tCO2/MWh including imports** (0.678 excluding),
  = 1189.04 Mt CO2 / 1761.28 BU net generation. Earlier years: FY 2023-24 0.727, FY 2024-25 0.710.
  PDF https://cea.nic.in/api/cdm-report-version/view-pdf/en/82, XLSX .../83, retrieved 2026-10-08.
- Re-checked 2026-10-10 for the page's "CEA database version" and "factor type" labels: the User Guide PDF (35 pages) and the
  workbook (dated 2026-08-01, Results sheet) both open at the links above and give the figures quoted; the same URLs for the
  next two document numbers (.../84, .../85) return nothing, so Version 22.0 is the newest this route reaches. The CEA
  baseline page itself is an application that asks for a login, so it could not be read as a page from here: if a newer
  version exists, the owner can type its factor into the editable field, and the page labels the number an assumption.
- Factor type used: the weighted average grid emission rate (including renewables and captive plants), including imports,
  FY 2025-26. The same Results sheet also has simple operating margin, build margin and combined margin rows; they are
  different measures from the weighted average and are not used here.

## Water per panel cleaning (REMOVED from the page on 2026-10-10: no sourced litre figure is shown any more; kept as the record of what was read)

- Review of aqueous PV cleaning as reported by pv magazine India (2025-02-05): "The minimum water consumption for
  aqueous cleaning is 0.31 L/m2, the maximum is 4.95 L/m2, and the average water consumption is 2.1 L/m2"
  (https://www.pv-magazine-india.com/2025/02/05/pressurized-water-cleaning-can-improve-pv-generation-efficiency-by-10/).
  Renewable Watch (2020-12-03), citing CEEW: "3-5 litres" per panel per cleaning in normal areas, 7-8 L in arid areas
  (https://renewablewatch.in/2020/12/03/waterless-way/). Retrieved 2026-10-08.
- How it was used: a residential panel is about 2 m², so 4 L per panel sat in the middle of the sourced range. The page no
  longer shows litres, or asks for the number of panels, because that figure was an estimate of ours, not a sourced one.

## Cleaning cost and frequency (default Rs 150 per kW per visit; fortnightly)

- **CEEW (Council on Energy, Environment and Water), "Maximising Rooftop Solar Performance by Enabling a Robust O&M
  Ecosystem", June 2026**: "the cost for cleaning services alone is INR 100 - 200 per kW per visit, and for bundled
  services, INR 300 - 500 per kW per visit. We have assumed average values of INR 150 per kW for cleaning only".
  https://www.ceew.in/sites/default/files/ceew-oandm-ecosystem-for-rts-web-ready-file.pdf, retrieved 2026-10-08.
- Vendor price page (labelled as such): SolarSquare "Assure" packages, about Rs 390-450 per visit for plants up to
  3.25 kWp (https://www.solarsquare.in/blog/solar-panel-cleaning-pricing-in-india/, updated 2026-07-24).
- Panels on the roof (default about 2 per kW): our own guess, not from a source; the page says so and the owner counts
  and corrects it.
- Frequency: BHEL O&M specification for a rooftop plant: "cleaned at least once every fifteen days for rooftop"
  (https://tenders.bhel.com/sites/default/files/TS-2021-11-01-04%3A22%3A11.pdf, 2021). Roorkee field study (Shukla et al.,
  Scientific Reports, 14 April 2026, https://www.nature.com/articles/s41598-026-45485-2): monthly soiling loss 1-1.5 %
  with weekly cleaning, 2.5 % biweekly, 5 % every four weeks (about 0.17-0.21 % per day). Retrieved 2026-10-08.

## Fonts (inlined, Phase 7; pruned to the page's words, Phase 9)

Noto Sans Devanagari Regular and Noto Sans Gurmukhi Regular, unhinted static TTFs from the Noto project
(https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Regular.ttf,
.../NotoSansGurmukhi/unhinted/ttf/NotoSansGurmukhi-Regular.ttf), **SIL Open Font License 1.1**, Copyright 2022 The
Noto Project Authors (https://raw.githubusercontent.com/google/fonts/main/ofl/notosansdevanagari/OFL.txt). Retrieved
2026-10-08. Phase 7 subset them to the characters the page uses (`pyftsubset --text-file ... --layout-features='*'`),
which kept 496 Devanagari glyphs because fontTools keeps every conjunct any pair of the kept letters could form
(fontTools subset docs, https://fonttools.readthedocs.io/en/latest/subset/index.html, retrieved 2026-10-08).

Phase 9 prunes further, to the words the page really writes. `scripts/subset_fonts.py` (run by
`bash scripts/build_fonts.sh` through `uv run --with`, pinned: fontTools 4.66.1, brotli 1.2.0, uharfbuzz 0.56.3, a
Python binding of HarfBuzz, https://pypi.org/pypi/uharfbuzz/json, retrieved 2026-10-10; build tools, not project
dependencies) does this:

1. It takes every run of characters inside a font's `unicode-range` from the page text (the units the browser shapes
   with that font) and writes them to `fixtures/fonts/deva.runs.txt` and `guru.runs.txt`.
2. It shapes each run with the full font in HarfBuzz and records every glyph present at any lookup step.
3. It subsets to those glyphs with layout closure switched off, so the font ships only the substitutions those words use.
4. It shapes every run again with the pruned font and exits non-zero unless the glyphs, clusters, advances and offsets
   are identical to the full font's.

Result: Devanagari 129 of 845 glyphs, 12,228 bytes (was 29,036 with 496 glyphs); Gurmukhi 83 of 282 glyphs, 6,360 bytes
(was 9,384). They are inlined as base64 `@font-face` data URLs, which needs `font-src data:` in the CSP.
`tests/test_loop.py` fails while the page has a word that is not in the runs files, so a new Hindi or Punjabi word
cannot ship with a font that cannot shape it.

## Browser facts used by Phase 7

- `speechSynthesis`: Chrome ships a network Hindi voice (hi-IN) but no Punjabi (pa-IN) voice, so the page shows the
  read-aloud button only when a voice for the chosen language exists.
- `SpeechRecognition`: in Chrome the audio is sent to Google's servers for recognition; hi-IN is listed, pa-IN is
  not. The page says so next to the microphone and only shows the microphone where the API exists.
- `navigator.vibrate`: Android Chrome, after a user gesture; not iOS Safari. The page calls it only after a
  confirmation and ignores failure.
- Sources: MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition,
  https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate), Chrome developer documentation, retrieved 2026-10-08.
