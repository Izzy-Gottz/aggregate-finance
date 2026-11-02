# Builds docs/institutions.json from Plaid's public coverage file (plaid.com/documents/us_institution_coverage.csv).
# Names only: no ids, no product columns, no logos. US rows Aggregate can read: transactions or investments.
# Usage: python3 -I scripts/institution-names.py <coverage.csv> docs/institutions.json
import csv, json, sys

lines = open(sys.argv[1], encoding='utf-8-sig').read().splitlines()
generated = lines[0].split(': ', 1)[1][:10]
rows = csv.DictReader(lines[1:])
names = {r['name'].strip() for r in rows if r['country'] == 'US' and '1' in (r['transactions'], r['investments'])}
out = {'generated': generated, 'names': sorted(names, key=str.casefold)}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, separators=(',', ':'))
