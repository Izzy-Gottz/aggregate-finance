// Preload for arm B's server and CLI: the clock starts at BENCH_NOW (the benchmark's sync time on as_of) and runs
// forward in real time, so the demo imports history up to as_of and "today" in every tool answer is as_of.
// Benchmark-only; not used by the product.
const now = process.env.BENCH_NOW
if (now) {
  const offset = Date.parse(now) - Date.now()
  const RealDate = Date
  class BenchDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a) }
    static now() { return RealDate.now() + offset }
  }
  globalThis.Date = BenchDate
}
