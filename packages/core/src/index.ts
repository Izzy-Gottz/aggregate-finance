// @agfn/core: the double-entry ledger, links/matching, rules, buckets, checks, metrics and reports (S1).
export { LedgerEngine, LinkError, contentHash, type EngineOptions, type JournalExport, type PostOptions } from './engine.ts'
export { runwayBand, verifiedBadges, type Badge, type RunwayBand, type VerifiedBadges } from './badges.ts'
export * from './coa.ts'
export * from './money.ts'
export type * from './model.ts'
export type { AccountDirectory, ConnectionInfo, LedgerStore, RateSource, LineRow, AccountTotal, LineFilter, RecordFilter, LinkFilter } from './store.ts'
export { KyselyLedgerStore, KyselyDirectory, DbScope, type LedgerTables } from './kysely-store.ts'
export { MemoryLedgerStore, MemoryDirectory, defaultIncludeInCash } from './memory-store.ts'

export { MemoryRateSource, FrankfurterRateSource, CachedRateSource, RateUnavailableError, type FrankfurterOptions } from './fx.ts'
export { applyRules, globMatch, merchantKey, ruleMatches, suggestRules, validateRule, RuleValidationError, type RuleSuggestion } from './rules.ts'
export { findMatches, nameSimilarity, AUTO_CONFIRM, PROPOSE_MIN, type Proposal } from './matching.ts'
export { classifyTxn, interEntityRole, plan, PostingError, type Classification, type PlannedEntry, type PlannedLine } from './posting.ts'
export { runChecks, openItems, type CheckName, type CheckResult, type CheckOptions, type OpenItem } from './checks.ts'
export { computeMetric, MAX_ROW_IDS, type CoreMetricAnswer, type MetricProvider } from './metrics.ts'
export { profitAndLoss, balanceSheet, cashFlow, type ProfitAndLoss, type BalanceSheet, type CashFlow, type ReportSection, type ReportLine } from './reports.ts'
export { listReviewItems, type ReviewItem, type ReviewKind } from './review.ts'
export {
  bucketView,
  detectRecurring,
  dueDates,
  monthlyEquivalent,
  scheduleStatus,
  validateFields,
  validateSchedule,
  validateValues,
  BucketValidationError,
  type BucketView,
  type Occurrence,
  type OccurrenceStatus,
  type RecurringSeries,
} from './buckets.ts'
export { EventValidationError, LedgerInvariantError, assertEntryBalanced, validateEvent } from './validate.ts'
export { createFinance, type Finance } from './finance.ts'
export { LedgerFinanceReader, bankRows, type ReaderProviders, type TxnUpsertWithId } from './finance-reader.ts'
export { LedgerRecordWriter, resolveCategory, type EquityWriter, type WriterOptions } from './record-writer.ts'
export { dataHealth, type DataHealth } from './health.ts'
// The workspace's own day and month periods, so the app labels periods exactly as the metrics count them.
export { DEFAULT_TIME_ZONE, localDate, trailingMonths } from './queries.ts'
export { findAnomalies, type Anomaly, type AnomalyKind, type AnomalyOptions } from './anomalies.ts'
export { weeklyDigest, shortMoney, type WeeklyDigest } from './digest.ts'
export { coverage, assertionChecks, type AccountCoverage, type CoverageMonth, type CoverageOptions, type CoverageStatus } from './coverage.ts'
export { parseQuery, matchesFilter, QueryError, type TxnFilter, type FilterRow } from './query.ts'
