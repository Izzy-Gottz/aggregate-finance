# Finance Agent Benchmark: results (v3, 2026-10-12)

The same 100 questions about one synthetic company (Harbor Coffee), answered by one model, Claude Haiku 5.5, in two
ways:

- **Arm A, exports + Python:** the files an owner would download, read with one `run_python` tool (pandas, numpy).
- **Arm B, Aggregate:** the same events imported into a local Aggregate, read with its read-only MCP tools.

`method.md` has the data, the definitions and the scoring. The answers come from `truth.ts`, which reads the events
directly and never uses Aggregate. Scoring is automatic: an answer is correct when it's within the question's
tolerance, with no model grading.

## Headline

| | Arm A: exports + Python | Arm B: Aggregate |
|---|---|---|
| Correct | **98 / 100** | **100 / 100** |
| Wrong (confident) | 2 | 0 |
| Abstained, no answer, error | 0 | 0 |
| Cost for 100 questions | **$0.17** | **$0.41** |
| Input tokens per question, median / p90 | 5,870 / 23,701 | 10,266 / 80,877 |
| Output tokens per question, median / p90 | 1,028 / 2,758 | 1,026 / 2,058 |
| Tool calls per question, median / p90 / max | 2 / 4 / 6 | 4 / 6 / 15 |
| Latency per question, median / p90 | 7.3 s / 15.0 s | 6.0 s / 11.5 s |
| Run | `results/2026-10-13T00-01-05` | `results/2026-10-13T02-56-59` |

Per category (correct / asked):

| | balances | sales | fees | payouts | transfers | expenses | bills | subscriptions | card |
|---|---|---|---|---|---|---|---|---|---|
| Arm A | 12/12 | 16/16 | 8/8 | 10/10 | 10/10 | 16/16 | 9/10 | 9/10 | 8/8 |
| Arm B | 12/12 | 16/16 | 8/8 | 10/10 | 10/10 | 16/16 | 10/10 | 10/10 | 8/8 |

## Read this before quoting the numbers

- **Arm A is close to a best case for exports.** Its files are rendered from the same events, complete and
  consistent, with one company and no missing months. Real exports are often partial, renamed or in a newer layout.
  The benchmark doesn't measure that, so Arm A's 98 is what a model does with tidy files.
- **Arm A is cheaper.** It cost $0.17 against Arm B's $0.41. Arm B makes about twice the tool calls, and each
  turn re-sends the earlier tool answers, so its input tokens are higher. Output tokens are about equal.
- **Arm B was improved on this question set.** Between runs, Aggregate was changed in response to Arm B's misses on
  these same 100 questions. The changes:
  - a higher read limit;
  - shorter tool answers;
  - hints when a product name is used as a company;
  - MRR answers that name their products;
  - processor fee rows reachable from the charge's words;
  - clearer wording in a revenue formula.

  None of them changed the ledger or how a figure is computed. They change what the tools return and the notes
  they add. Arm A got no equivalent tuning (its harness and files didn't change). Arm B's runs in order on the v3 scorer: 96, 97, 98, then 100. An earlier Arm B run, under v2 on an older build,
  scored 77.
- **One run per arm.** Each arm also answered a fixed 10-question repeat:
  - Arm A: 10/10 (`results/2026-10-13T00-15-29`).
  - Arm B: 9/10 (`results/2026-10-13T00-31-50`), on the first v3 build, before the fee fix.

  Small differences (one or two questions) are within run-to-run noise.
- **One model.** Only Claude Haiku 5.5 was run (decided 2026-10-12, to keep the cost of reruns low). Larger models
  weren't measured.

## Arm A's two misses

Both are model errors. The exports hold the right answer and the key is right (checked against the files).

- **bills-05** (answered 31, expected 29). The bank export supports 29: 26 bills paid a few cents short plus 3
  with no payment yet. Recomputing from `checking-5512.csv` by bill number gives exactly 29. The agent counted 28
  short payments instead of 26.
- **subscriptions-09**, Bean Club MRR on 2025-09-30 (answered 1,354, expected 1,238). The agent summed each
  subscription's *current* plan amount from `stripe-subscriptions.csv`. 5 of the 29 members active that day upgraded
  later (e.g. 32 → 54, 18 → 54). Their September 2025 charges (`stripe-balance-history.csv`) total 1,238.

## Arm B's runs

All runs used scorer v3 (`FROZEN` d750b699…). Only the final run is the headline.

| Run | Aggregate build (main) | Score | Cost | What changed before it |
|---|---|---|---|---|
| `2026-10-13T00-18-43` | 5b68aa8b | 96/100 | $0.58 | read limit 120/min (was 60) |
| `2026-10-13T00-48-23` | 2e231553 | 97/100 | $0.48 | shorter tool answers; fee notes |
| `2026-10-13T02-19-22` | 72085eda | 98/100 | $0.41 | MRR names its products; product-name hint |
| `2026-10-13T02-56-59` | d5261737 | **100/100** | $0.41 | fee rows found by the charge's words; revenue formula wording |

Arm A ran with main at 5b68aa8b. Its result doesn't depend on Aggregate's build, only on the exports and the harness.

## Files

Each run directory under `results/` has:

- `run.json`: the run's settings, freeze hash and question list.
- `scores.jsonl`: one line per answer, with verdict, the answer given, the expected answer, tokens, cost and time.
- `stats.md`: tokens, tool calls and latency per question.
- `transcripts-Claude Haiku 5.5-{A,B}.jsonl`: every turn, tool call and tool answer. Included for the headline and
  repeat runs.

## Reproduce

From a checkout of this repository, with an Anthropic API key in an env file:

```sh
# The freeze check: the runner refuses a scored run unless FROZEN matches these files.
cat docs/benchmark/FROZEN

# Arm A needs Docker and the sandbox image named in config.json
docker build -t agfn-bench-python:1 scripts/benchmark/sandbox
BENCH_BUDGET_USD=4 node --env-file=.env.benchmark scripts/benchmark/run.ts --arms A --runs 1

# Arm B: start a local Aggregate holding the same events, then run against it
BENCH_KEY_FILE=/tmp/bench-key.json node scripts/benchmark/serve.ts
BENCH_KEY_FILE=/tmp/bench-key.json BENCH_BUDGET_USD=1 node --env-file=.env.benchmark scripts/benchmark/run.ts --arms B --runs 1

# The 10-question repeat (ids in config.json, repeat_subset)
node --env-file=.env.benchmark scripts/benchmark/run.ts --arms A --runs 1 --only <ids>
```

Each run writes a new `docs/benchmark/results/<time>/`. Model answers vary from run to run, so expect small
differences.
