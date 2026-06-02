import csv
import os
import re
import psycopg2
import psycopg2.extras

DB_URL = os.environ["LANEIQ_DATABASE_URL"]

FILES = [
    ("GA-clean-no load#.csv", "GA"),
    ("east-cons-clean_no load#.csv", "EAST"),
    ("laneiq-master- no load#.csv", "MASTER"),
]

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def clean_rate(value):
    if not value or not value.strip():
        return None
    try:
        return float(re.sub(r"[$,]", "", value.strip()))
    except ValueError:
        return None


def main():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS lanes (
            id               SERIAL PRIMARY KEY,
            origin           TEXT,
            pu_date          TEXT,
            destination      TEXT,
            weight_info      TEXT,
            rate             NUMERIC,
            pickup_address   TEXT,
            delivery_address TEXT,
            commodity        TEXT,
            source_file      TEXT
        )
    """)
    cur.execute("TRUNCATE TABLE lanes RESTART IDENTITY")
    conn.commit()
    print("Table ready.")

    total = 0
    for filename, source_label in FILES:
        path = os.path.join(BASE_DIR, filename)
        batch = []
        with open(path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                batch.append((
                    row.get("Origin", "").strip() or None,
                    row.get("PU Date", "").strip() or None,
                    row.get("Destination", "").strip() or None,
                    row.get("Weight / Pallets / FT", "").strip() or None,
                    clean_rate(row.get("Rate", "")),
                    row.get("Pickup Company + Full Address", "").strip() or None,
                    row.get("Delivery Company + Full Address", "").strip() or None,
                    row.get("Commodity", "").strip() or None,
                    source_label,
                ))

        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO lanes
               (origin, pu_date, destination, weight_info, rate,
                pickup_address, delivery_address, commodity, source_file)
               VALUES %s""",
            batch,
            page_size=500,
        )
        conn.commit()
        print(f"  {source_label}: {len(batch)} rows")
        total += len(batch)

    cur.close()
    conn.close()
    print(f"\nTotal rows loaded: {total}")


if __name__ == "__main__":
    main()
