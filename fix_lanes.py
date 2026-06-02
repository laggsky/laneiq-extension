import csv, os, re, psycopg2

DB_URL = os.environ["LANEIQ_DATABASE_URL"]

FILES = [
    ("GA-clean-no load#.csv", "GA"),
    ("east-cons-clean_no load#.csv", "EAST"),
    ("laneiq-master- no load#.csv", "MASTER"),
]

def clean_rate(v):
    if not v or not v.strip(): return None
    try: return float(re.sub(r'[\$,]', '', v.strip()))
    except: return None

conn = psycopg2.connect(DB_URL)
cur = conn.cursor()

cur.execute("TRUNCATE TABLE lanes RESTART IDENTITY")
conn.commit()
print("Table truncated.")

total = 0
for fname, label in FILES:
    count = 0
    with open(fname, newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            cur.execute(
                "INSERT INTO lanes (origin,pu_date,destination,weight_info,rate,pickup_address,delivery_address,commodity,source_file) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (row.get('Origin','').strip() or None,
                 row.get('PU Date','').strip() or None,
                 row.get('Destination','').strip() or None,
                 row.get('Weight / Pallets / FT','').strip() or None,
                 clean_rate(row.get('Rate','')),
                 row.get('Pickup Company + Full Address','').strip() or None,
                 row.get('Delivery Company + Full Address','').strip() or None,
                 row.get('Commodity','').strip() or None,
                 label))
            count += 1
    conn.commit()
    print(f"  {label}: {count} rows")
    total += count

cur.close()
conn.close()
print(f"\nTotal rows loaded: {total}")
