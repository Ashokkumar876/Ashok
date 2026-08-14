"""
Edge band price lookup for the Parametric Master Sheet.

Business rule (validated against data/parametric_master_sheet.csv):

  Panel type   Thickness band     Edge band column(s) tried, in order
  -----------  ------------------ ------------------------------------
  Carcass      up to 18.5mm       22_0p8, 22_1p0, 23_1p3
  Shutter      up to 18.5mm       22_2p0, 22_1p0, 23_1p3
  Carcass      18.5mm - 26.5mm    30_0p8
  Shutter      18.5mm - 26.5mm    30_2p0
  Carcass      26.5mm - 41.5mm    45_0p8
  Shutter      26.5mm - 41.5mm    45_2p0

For a given material row only one of the "up to 18.5mm" columns is ever
populated (Laminate Matt -> 22_0p8/22_2p0, Laminate Glossy and Acrylic ->
23_1p3, some Acrylic sub-brands -> 22_1p0), so trying them in order and
taking the first non-zero value is safe and needs no hardcoded
material-type/finish branching. The 30_x and 45_x columns are simply blank
for Acrylic and Laminate Glossy, so "not available" falls out of the data
automatically instead of needing a special case.
"""

import csv
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CSV_PATH = Path(__file__).parent / "data" / "parametric_master_sheet.csv"

# 0-indexed column positions in the source CSV.
COL = {
    "serial_number": 0,
    "product_name": 1,
    "custom_code": 2,
    "material_type": 7,
    "material_finish": 8,
    "eb_brand": 18,
    "eb_description": 19,
    "22_0p8": 21,
    "22_1p0": 22,
    "22_2p0": 23,
    "23_1p3": 24,
    "25_1p3": 25,
    "30_0p8": 26,
    "30_2p0": 27,
    "45_0p8": 28,
    "45_2p0": 29,
}

EB_COLUMNS = (
    "22_0p8", "22_1p0", "22_2p0", "23_1p3", "25_1p3",
    "30_0p8", "30_2p0", "45_0p8", "45_2p0",
)

THICKNESS_BANDS = (
    ("upto_18.5", 0.0, 18.5),
    ("18.5_to_26.5", 18.5, 26.5),
    ("26.5_to_41.5", 26.5, 41.5),
)

PANEL_TYPES = ("Carcass", "Shutter")

COLUMN_PRIORITY = {
    ("Carcass", "upto_18.5"): ("22_0p8", "22_1p0", "23_1p3"),
    ("Shutter", "upto_18.5"): ("22_2p0", "22_1p0", "23_1p3"),
    ("Carcass", "18.5_to_26.5"): ("30_0p8",),
    ("Shutter", "18.5_to_26.5"): ("30_2p0",),
    ("Carcass", "26.5_to_41.5"): ("45_0p8",),
    ("Shutter", "26.5_to_41.5"): ("45_2p0",),
}


@dataclass
class MaterialRow:
    serial_number: str
    product_name: str
    custom_code: str
    material_type: str
    material_finish: str
    eb_brand: str
    eb_description: str
    eb_prices: dict  # column name -> float

    @classmethod
    def from_csv_row(cls, row):
        def num(col):
            raw = row[COL[col]].strip() if COL[col] < len(row) else ""
            try:
                return float(raw)
            except ValueError:
                return 0.0

        return cls(
            serial_number=row[COL["serial_number"]].strip(),
            product_name=row[COL["product_name"]].strip(),
            custom_code=row[COL["custom_code"]].strip(),
            material_type=row[COL["material_type"]].strip(),
            material_finish=row[COL["material_finish"]].strip(),
            eb_brand=row[COL["eb_brand"]].strip(),
            eb_description=row[COL["eb_description"]].strip(),
            eb_prices={c: num(c) for c in EB_COLUMNS},
        )


def load_materials(csv_path=DEFAULT_CSV_PATH):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # header
        return [
            MaterialRow.from_csv_row(row)
            for row in reader
            if row and row[COL["product_name"]].strip()
        ]


def classify_thickness(thickness_mm):
    for band, lower, upper in THICKNESS_BANDS:
        if lower < thickness_mm <= upper or (lower == 0 and thickness_mm <= upper):
            return band
    raise ValueError(
        f"No edge band thickness band covers {thickness_mm}mm "
        f"(max supported is {THICKNESS_BANDS[-1][2]}mm)"
    )


def get_edge_band_price(material: MaterialRow, panel_type: str, thickness_mm: float):
    """Return (column_used, price) for this material, or (None, None) if this
    material is not offered as an edge band at this panel type/thickness."""
    if panel_type not in PANEL_TYPES:
        raise ValueError(f"panel_type must be one of {PANEL_TYPES}, got {panel_type!r}")

    band = classify_thickness(thickness_mm)
    for column in COLUMN_PRIORITY[(panel_type, band)]:
        price = material.eb_prices.get(column, 0.0)
        if price > 0:
            return column, price
    return None, None


def find_material(materials, code):
    code = code.strip().lower()
    for m in materials:
        if code in (m.serial_number.lower(), m.custom_code.lower(), m.product_name.lower()):
            return m
    return None


def build_lookup_table(materials):
    """Flatten the sparse 9-column matrix into one row per
    (material, panel type, thickness band) that actually has a price.
    This is the 'optimized' shape for a quoting engine: a single
    exact-match lookup instead of picking from 9 sparse columns."""
    rows = []
    for m in materials:
        if not any(m.eb_prices.values()):
            continue
        for panel_type in PANEL_TYPES:
            for band, _, _ in THICKNESS_BANDS:
                column = next(
                    (c for c in COLUMN_PRIORITY[(panel_type, band)] if m.eb_prices.get(c, 0) > 0),
                    None,
                )
                if column is None:
                    continue
                rows.append({
                    "product_name": m.product_name,
                    "custom_code": m.custom_code,
                    "material_type": m.material_type,
                    "material_finish": m.material_finish,
                    "eb_brand": m.eb_brand,
                    "panel_type": panel_type,
                    "thickness_band_mm": band,
                    "edge_band_code": column,
                    "price_per_running_meter": m.eb_prices[column],
                })
    return rows


def write_lookup_csv(rows, out_path):
    fieldnames = [
        "product_name", "custom_code", "material_type", "material_finish",
        "eb_brand", "panel_type", "thickness_band_mm", "edge_band_code",
        "price_per_running_meter",
    ]
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _cli():
    import argparse

    parser = argparse.ArgumentParser(description="Look up the edge band price for a material.")
    parser.add_argument("code", help="Product serial number, custom code, or product name")
    parser.add_argument("panel_type", choices=PANEL_TYPES)
    parser.add_argument("thickness_mm", type=float)
    parser.add_argument("--csv", default=DEFAULT_CSV_PATH)
    args = parser.parse_args()

    materials = load_materials(args.csv)
    material = find_material(materials, args.code)
    if material is None:
        print(f"No material found matching {args.code!r}", file=sys.stderr)
        sys.exit(1)

    column, price = get_edge_band_price(material, args.panel_type, args.thickness_mm)
    if price is None:
        print(
            f"{material.product_name} ({material.material_type}/{material.material_finish}) "
            f"has no edge band available for {args.panel_type} at {args.thickness_mm}mm"
        )
        sys.exit(2)

    print(
        f"{material.product_name} ({material.material_type}/{material.material_finish}) "
        f"-> Edge Band {column}: {price} per running meter"
    )


if __name__ == "__main__":
    _cli()
