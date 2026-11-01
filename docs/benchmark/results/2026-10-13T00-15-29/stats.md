# Per-question cost and effort (2026-10-13T00-15-29, arm A)

```json
{
 "n": 10,
 "arm": "A",
 "usd": 0.01661,
 "inTok": {
  "total": 87256,
  "median": 3544,
  "p90": 12953
 },
 "cachedTok": 81568,
 "outTok": {
  "total": 14152,
  "median": 869,
  "p90": 2808
 },
 "calls": {
  "total": 23,
  "median": 2,
  "p90": 4,
  "max": 4
 },
 "latencyS": {
  "median": 6.864,
  "p90": 16.474
 }
}
```

| id | verdict | input tok | cached | output tok | tool calls | turns | latency s | $ |
|---|---|---|---|---|---|---|---|---|
| balances-05 | correct | 3498 | 7647 | 1042 | 2 | 5 | 8.0 | 0.0009 |
| sales-05 | correct | 1652 | 7647 | 963 | 2 | 5 | 6.7 | 0.0007 |
| sales-12 | correct | 12953 | 12745 | 2736 | 4 | 9 | 16.5 | 0.0028 |
| fees-05 | correct | 11393 | 12745 | 2808 | 4 | 9 | 15.8 | 0.0027 |
| payouts-05 | correct | 2076 | 5098 | 610 | 1 | 3 | 4.2 | 0.0006 |
| transfers-05 | correct | 3544 | 5098 | 411 | 1 | 3 | 3.2 | 0.0006 |
| expenses-05 | correct | 5852 | 7647 | 613 | 2 | 5 | 10.8 | 0.0010 |
| bills-05 | correct | 36968 | 12745 | 3496 | 4 | 9 | 19.0 | 0.0056 |
| subscriptions-05 | correct | 8712 | 5098 | 869 | 2 | 3 | 6.9 | 0.0014 |
| card-05 | correct | 608 | 5098 | 604 | 1 | 3 | 4.9 | 0.0004 |
