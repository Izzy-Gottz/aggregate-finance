# Per-question cost and effort (2026-10-13T00-31-50, arm B)

```json
{
 "n": 10,
 "arm": "B",
 "usd": 0.062449999999999985,
 "inTok": {
  "total": 519178,
  "median": 25914,
  "p90": 114770
 },
 "cachedTok": 425944,
 "outTok": {
  "total": 12584,
  "median": 941,
  "p90": 1692
 },
 "calls": {
  "total": 46,
  "median": 3,
  "p90": 7,
  "max": 11
 },
 "latencyS": {
  "median": 6.539,
  "p90": 10.387
 }
}
```

| id | verdict | input tok | cached | output tok | tool calls | turns | latency s | $ |
|---|---|---|---|---|---|---|---|---|
| balances-05 | correct | 6304 | 34536 | 789 | 3 | 5 | 4.9 | 0.0014 |
| sales-05 | correct | 126429 | 57560 | 1491 | 6 | 9 | 9.8 | 0.0140 |
| sales-12 | correct | 13729 | 23024 | 781 | 3 | 3 | 4.2 | 0.0020 |
| fees-05 | wrong | 25914 | 69072 | 3263 | 11 | 11 | 15.5 | 0.0049 |
| payouts-05 | correct | 114770 | 69072 | 1491 | 7 | 11 | 9.5 | 0.0129 |
| transfers-05 | correct | 87907 | 46048 | 941 | 5 | 7 | 6.7 | 0.0097 |
| expenses-05 | correct | 7334 | 34536 | 1365 | 2 | 5 | 6.5 | 0.0018 |
| bills-05 | correct | 49185 | 23024 | 572 | 2 | 3 | 3.8 | 0.0054 |
| subscriptions-05 | correct | 86721 | 46048 | 1692 | 6 | 7 | 10.4 | 0.0100 |
| card-05 | correct | 885 | 23024 | 199 | 1 | 3 | 2.9 | 0.0004 |
