# Builds docs/institutions.json from Plaid's public coverage file (plaid.com/documents/us_institution_coverage.csv).
# Names, plus one flag character per name for the groups on the connectors page (Yisrael, 2026-11-03: groups from
# Plaid's product columns). No ids, no other columns, no logos. US rows Aggregate can read: transactions or investments.
# Flags (a hex digit per name, same order): 1 bank accounts (auth), 2 investments, 4 liabilities (loans, mortgages,
# cards), 8 a crypto exchange (by name: the coverage file has no crypto column).
# Usage: python3 -I scripts/institution-names.py <coverage.csv> docs/institutions.json
import csv, json, sys

CRYPTO = {'Binance US (Crypto Exchange)', 'BitGo (Crypto Assets)', 'Bitcoin IRA', 'Coinbase Crypto', 'Gemini', 'Kraken'}

lines = open(sys.argv[1], encoding='utf-8-sig').read().splitlines()
generated = lines[0].split(': ', 1)[1][:10]
flags = {}
for r in csv.DictReader(lines[1:]):
    if r['country'] != 'US' or '1' not in (r['transactions'], r['investments']):
        continue
    name = r['name'].strip()
    f = (r['auth'] == '1') | (r['investments'] == '1') << 1 | (r['liabilities'] == '1') << 2 | (name in CRYPTO) << 3
    flags[name] = flags.get(name, 0) | f
names = sorted(flags, key=lambda n: (n.casefold(), n))
out = {'generated': generated, 'names': names, 'flags': ''.join('%x' % flags[n] for n in names)}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, separators=(',', ':'))
