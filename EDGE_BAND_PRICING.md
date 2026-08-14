# Edge Band Pricing Logic

Source data: `data/parametric_master_sheet.csv` (753 material rows, 617 of
which carry edge band pricing).

## Rule, confirmed against the data

| Panel type | Panel thickness    | Edge band column(s) tried, in order        |
|------------|---------------------|----------------------------------------------|
| Carcass    | up to 18.5mm         | `22_0p8`, `22_1p0`, `23_1p3`                 |
| Shutter    | up to 18.5mm         | `22_2p0`, `22_1p0`, `23_1p3`                 |
| Carcass    | 18.5mm - 26.5mm       | `30_0p8`                                     |
| Shutter    | 18.5mm - 26.5mm       | `30_2p0`                                     |
| Carcass    | 26.5mm - 41.5mm       | `45_0p8`                                     |
| Shutter    | 26.5mm - 41.5mm       | `45_2p0`                                     |

For a given material, take the price in the **first non-zero column** for
its (panel type, thickness band) cell. This single rule reproduces every
constraint you described, with no material-type special-casing needed,
because the exceptions are already baked into which cells are populated:

- **Laminate Matt** (90 rows) is the only group with all six columns
  (`22_0p8/22_2p0`, `30_0p8/30_2p0`, `45_0p8/45_2p0`) populated — it's the
  only material available across all three thickness bands.
- **Laminate Glossy** (17 rows) and **Acrylic** (43 rows) only ever have
  `23_1p3` populated (a handful of Acrylic rows use `22_1p0` instead, from a
  different EB supplier — PRINTECH KR vs. Sewon). Their `30_x`/`45_x` cells
  are blank, so "Glossy/Acrylic won't come" in the 18.5-26.5mm and
  26.5-41.5mm bands falls out automatically — no explicit exclusion list
  needed.
- No material row ever has more than one of `22_0p8` / `22_1p0` / `23_1p3`
  populated at once, so "first non-zero wins" never has to arbitrate a
  genuine conflict — it's really just "read the one column that has a
  price."
- The `25_1p3` column is present in the sheet but unused (0 across all 753
  rows) — reserved for a future tape size, not part of any current rule.
- 9 Laminate Matt rows (`INLxxxA/B/C` — the same decor at 0.8mm/1mm/1.25mm
  base thicknesses) only have `22_0p8` and `45_0p8` filled in, missing
  `22_2p0`/`30_0p8`/`30_2p0`/`45_2p0` — likely incomplete data entry worth
  reviewing in the source sheet.

## Implementation

`edge_band_pricing.py`:

- `load_materials(csv_path)` — parses the master sheet into `MaterialRow`s.
- `get_edge_band_price(material, panel_type, thickness_mm)` — returns
  `(column_used, price)` for one material, or `(None, None)` if that
  material has no edge band at that panel type/thickness (e.g. Acrylic at
  30mm).
- `build_lookup_table(materials)` / `write_lookup_csv(...)` — flattens the
  sparse 9-column matrix into one row per (material, panel type, thickness
  band) that actually has a price. This is the "optimized" shape for a
  quoting engine: an exact-match lookup on
  `(product, panel_type, thickness_band)` instead of picking through 9
  mostly-empty columns per query. See `data/edge_band_lookup.csv`
  (617 rows, regenerate with the snippet below).
- CLI: `python edge_band_pricing.py <code> <Carcass|Shutter> <thickness_mm>`
  looks up one material by serial number, custom code, or product name.

Regenerate the flattened lookup table:

```python
from edge_band_pricing import load_materials, build_lookup_table, write_lookup_csv

materials = load_materials()
write_lookup_csv(build_lookup_table(materials), "data/edge_band_lookup.csv")
```

## Open question

Boundary handling at exactly 18.5mm / 26.5mm is currently inclusive on the
upper edge of each band (`18.5` → "up to 18.5mm", `26.5` → "18.5-26.5mm").
Confirm this matches your intended cutoffs.
