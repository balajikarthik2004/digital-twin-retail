"""
One-time conversion: real WMS Excel exports -> the app's bundled JSON data.

Reads the two raw exports at the repo root (`Inbound Dataset.xlsx`,
`Outbound Dataset.xlsx` — genuine WMS extracts, 194 and 118 columns of mostly
transactional/analytics fields the app has no use for) and cuts them down to
exactly what three seams in the app already know how to consume:

  src/data/realCatalog.json   -- real product identity (id/name/category/price)
  src/data/sampleOrders.json  -- real orders, in importOrders()'s existing shape
  src/data/realReceipts.json  -- the one real goods-in batch, in importReceipts()'s shape

Run once, offline: `python scripts/convert_real_data.py`. Never runs inside
the app itself — this is a data-prep step, not a runtime dependency. Also
drops a JSON+CSV mirror of the same three datasets into `real-data-export/`
at the repo root, purely so the cleaned data can be eyeballed in Excel.
"""

import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
INR_TO_USD = 1 / 83  # fixed conversion, since CurrentPrice/FullPrice are in INR

# Only three real parties in the outbound sample, all wholesale/store-transfer
# entities rather than consumer e-commerce -- map them onto the app's existing
# channels instead of defaulting everything to 'Ecommerce'.
PARTY_CHANNEL = {
    "Nexon Omniverse Limited (Formerly know as Ethnicity Limited)": "Wholesale",
    "ET - Sarath City Capital Mall Hyderabad": "Store Replen",
    "ETHNIQ RETAIL PRIVATE LIMITED - BHIWANDI": "Wholesale",
}
DEFAULT_CHANNEL = "Wholesale"

SHIFT_SECONDS = 3600 * 8  # spread synthetic release times across an 8h shift


def clean_str(v) -> str:
    if pd.isna(v):
        return ""
    return str(v).strip()


def title(v: str) -> str:
    return " ".join(w.capitalize() for w in v.split())


def barcode_key(row, *cols) -> str | None:
    for c in cols:
        if c in row and pd.notna(row[c]):
            s = str(row[c]).strip()
            if s and s.lower() != "nan":
                return s
    return None


def real_name(row) -> str:
    """Brand + family + colour -- the raw `Name` column is a style-colour code,
    not a human name (e.g. 'KB-MEL00001-123'), so it's never used here. Source
    text is shouty all-caps; title-cased to read like the synthetic catalogue
    it's replacing (e.g. 'Nordvale Cola 12pk', not 'NORDVALE COLA 12PK')."""
    brand = title(clean_str(row.get("Product Brand")).lower())
    family = title(clean_str(row.get("Family")).lower())
    color = title(clean_str(row.get("Color")).lower())
    parts = [p for p in [brand, family, color] if p]
    return " ".join(parts) if parts else title(clean_str(row.get("Style")).lower()) or "Unnamed product"


def real_price(row) -> float:
    inr = row.get("CurrentPrice")
    if pd.isna(inr) or inr == 0:
        inr = row.get("FullPrice")
    if pd.isna(inr) or inr == 0:
        inr = 500  # sane fallback, should not trigger given the data checked
    return round(float(inr) * INR_TO_USD, 2)


def build_catalog(inb: pd.DataFrame, outb: pd.DataFrame) -> list[dict]:
    catalog: dict[str, dict] = {}

    def absorb(df: pd.DataFrame, key_cols: list[str]):
        for _, row in df.iterrows():
            key = barcode_key(row, *key_cols)
            if not key or key in catalog:
                continue
            catalog[key] = {
                "id": key,
                "name": real_name(row),
                "category": title(clean_str(row.get("Division")).lower()) or "General",
                "price": real_price(row),
            }

    absorb(inb, ["ASN_SKU", "Putaway_SKU", "Item Code"])
    absorb(outb, ["Header SKU", "SKU", "Item Code"])
    return list(catalog.values())


def build_receipts(inb: pd.DataFrame) -> dict:
    """Group the one real ASN by (WMS_ASN_NO, SKU), summing ASNQTY per line.
    Every line is imported as 'expected' regardless of the source's historical
    PUTAWAY_QTY -- the twin hasn't received it yet, and replaying it as already
    received would skip the count-in -> plan -> putaway flow the Inbound tab
    exists to demonstrate."""
    receipts = []
    for asn_no, batch in inb.groupby("WMS_ASN_NO"):
        first = batch.iloc[0]
        lines = []
        grouped = batch.groupby("ASN_SKU")
        for sku, g in grouped:
            row = g.iloc[0]
            lines.append(
                {
                    "skuId": str(sku),
                    "name": real_name(row),
                    "category": title(clean_str(row.get("Division")).lower()) or "General",
                    "unitVolume": 1.0,
                    "expectedQty": int(g["ASNQTY"].sum()),
                }
            )
        receipts.append(
            {
                "ref": clean_str(asn_no),
                "po": clean_str(first.get("Pono")),
                "supplier": clean_str(first.get("VendorName")) or "Unknown",
                "unplanned": False,
                "lines": lines,
            }
        )
    return {"receipts": receipts}


def build_orders(outb: pd.DataFrame) -> dict:
    """Group outbound rows by Header ORDERNO into one order per group, one line
    per (order, SKU) summing Order Qty. Pick/pack/invoice progress columns in
    the source are ignored -- they describe what already happened in the real
    warehouse, not something meaningful to replay in a twin that hasn't picked
    the order yet."""
    orders = []
    order_groups = list(outb.groupby("Header ORDERNO"))
    n = max(1, len(order_groups))
    for i, (order_no, batch) in enumerate(order_groups):
        first = batch.iloc[0]
        party = clean_str(first.get("PARTYNAME"))
        channel = PARTY_CHANNEL.get(party, DEFAULT_CHANNEL)
        lines = []
        for sku, g in batch.groupby("Header SKU"):
            qty = int(g["Order Qty"].sum()) if pd.notna(g["Order Qty"]).any() else 1
            lines.append({"sku": str(sku), "qty": max(1, qty)})
        released_at = round((i / n) * SHIFT_SECONDS)
        orders.append(
            {
                "ref": clean_str(order_no),
                "channel": channel,
                "priority": "standard",
                "releasedAt": released_at,
                "lines": lines,
            }
        )
    return {"orders": orders}


def to_csv_rows(doc: dict, kind: str) -> list[dict]:
    if kind == "catalog":
        return doc
    if kind == "orders":
        rows = []
        for o in doc["orders"]:
            for line in o["lines"]:
                rows.append({"ref": o["ref"], "channel": o["channel"], "priority": o["priority"], "releasedAt": o["releasedAt"], **line})
        return rows
    if kind == "receipts":
        rows = []
        for r in doc["receipts"]:
            for line in r["lines"]:
                rows.append({"ref": r["ref"], "po": r["po"], "supplier": r["supplier"], **line})
        return rows
    return []


def write_csv(rows: list[dict], path: Path):
    if not rows:
        path.write_text("")
        return
    cols = list(rows[0].keys())
    lines = [",".join(cols)]
    for row in rows:
        vals = []
        for c in cols:
            v = row.get(c, "")
            s = str(v)
            if any(ch in s for ch in [",", '"', "\n"]):
                s = '"' + s.replace('"', '""') + '"'
            vals.append(s)
        lines.append(",".join(vals))
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    inb = pd.read_excel(ROOT / "Inbound Dataset.xlsx")
    outb = pd.read_excel(ROOT / "Outbound Dataset.xlsx")

    catalog = build_catalog(inb, outb)
    receipts_doc = build_receipts(inb)
    orders_doc = build_orders(outb)

    data_dir = ROOT / "src" / "data"
    (data_dir / "realCatalog.json").write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    (data_dir / "realReceipts.json").write_text(json.dumps(receipts_doc, indent=2), encoding="utf-8")
    (data_dir / "sampleOrders.json").write_text(json.dumps(orders_doc, indent=2), encoding="utf-8")

    export_dir = ROOT / "real-data-export"
    (export_dir / "json").mkdir(parents=True, exist_ok=True)
    (export_dir / "csv").mkdir(parents=True, exist_ok=True)
    for name, doc, kind in [
        ("real-catalog", catalog, "catalog"),
        ("real-orders", orders_doc, "orders"),
        ("real-receipts", receipts_doc, "receipts"),
    ]:
        (export_dir / "json" / f"{name}.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
        write_csv(to_csv_rows(doc, kind), export_dir / "csv" / f"{name}.csv")

    print(f"catalog:  {len(catalog)} distinct real SKUs")
    print(f"receipts: {len(receipts_doc['receipts'])} receipt(s), "
          f"{sum(len(r['lines']) for r in receipts_doc['receipts'])} line(s)")
    print(f"orders:   {len(orders_doc['orders'])} order(s), "
          f"{sum(len(o['lines']) for o in orders_doc['orders'])} line(s)")


if __name__ == "__main__":
    main()
