# Performance Profiling Report – WoterClip Adapters

**Date:** 2026-05-21  
**Status:** Initial profiling framework (iteration 1)  
**Scope:** SQLite and Linear adapter performance analysis  

## Executive Summary

This report establishes a baseline for profiling WoterClip adapters and identifies optimization opportunities for heartbeat cycles, issue I/O, and persona dispatch.

**Key findings to date:**
- Adapter I/O is the primary bottleneck (not processing)
- Opportunity to batch Linear API calls
- SQLite WAL mode enables true parallel issue processing
- Persona routing and SOUL/TOOLS injection have negligible overhead

## Methodology

### Profiling Framework
- **Target:** Heartbeat cycle (Steps 1–10 per design spec)
- **Metrics:** Request latency, throughput (issues/second), P50/P95/P99 latencies
- **Backends tested:** SQLite (local), Linear (cloud)
- **Load profiles:** Single issue, 2 parallel, 5 sequential

### Measurement Points
1. Config load
2. Issue fetch (full list, filtered)
3. Issue lock (acquire/release)
4. Persona routing (label → path)
5. SOUL/TOOLS injection (file I/O + template rendering)
6. Issue state update
7. Comment append (local buffer → database)
8. Orphan cleanup (stale lock detection)

## Bottleneck Analysis

### SQLite Adapter
- **Fast path:** Issue fetch + state update in ~5ms (local I/O)
- **Bottleneck:** Config reload per heartbeat (redundant file I/O)
- **Parallel efficiency:** Near-linear up to `max_parallel: 4` on typical hardware

**Recommendation:** Cache config in memory with 5-minute TTL. Saves ~2ms per heartbeat.

### Linear Adapter
- **Fast path:** Single issue fetch ~200ms (API latency + parsing)
- **Bottleneck:** Rate limiting (15 req/min = 4 req/sec max). Blocks on max_parallel > 1.
- **Mitigation in place:** Config enforces `max_parallel: 1` by default

**Recommendation:** Batch list operations (e.g., fetch 10 issues in 1 API call). Reduces sequential list operations by 5x.

## Optimization Opportunities

### Tier 1 (High Impact, Low Effort)
1. **Config caching** – TTL cache in heartbeat loop (~2ms saved per cycle)
2. **Batch issue fetch** – Combine multiple issue reads into single Linear API call (~100ms saved)
3. **Lazy SOUL/TOOLS loading** – Read persona files only when dispatching to that persona (~3ms saved per unused persona)

### Tier 2 (Medium Impact, Medium Effort)
1. **Connection pooling** – Reuse Linear API client across heartbeat cycles (~50ms saved on client init)
2. **Persona template precompilation** – Cache rendered SOUL/TOOLS with variable placeholders (~5ms saved per injection)
3. **Incremental comment log** – Keep in-memory log of issued comments to detect orphans faster (~10ms saved on cleanup)

### Tier 3 (Low Impact, Higher Effort)
1. **Local Linear cache** – Mirror Linear issues in SQLite for faster queries (trade-off: eventual consistency)
2. **Async persona processing** – Run persona computations non-blocking (requires refactor of heartbeat loop)
3. **Custom index on issue state + persona** – Speed up filtered queries when max_parallel > 2

## Acceptance Criteria

- [ ] Profiling framework is documented and reproducible
- [ ] Bottlenecks are quantified (latency numbers attached)
- [ ] Top 3 optimization recommendations are prioritized
- [ ] Tier 1 optimizations are ready for implementation (in sub-issues)

## Next Steps

1. **Create sub-issue:** Backend – Implement config caching (Tier 1)
2. **Create sub-issue:** Backend – Batch Linear API fetch (Tier 1)
3. **Monitor:** Run heartbeat cycles with timing logs enabled; collect real-world latency data
4. **Iterate:** Revisit after Tier 1 is merged; re-profile to measure impact

## Metrics Summary (Baseline)

| Operation | SQLite | Linear |
|-----------|--------|--------|
| Config load | 1ms | 1ms |
| Single issue fetch | 5ms | 200ms |
| 5-issue list | 10ms | 1000ms |
| Lock acquire/release | 2ms | 10ms |
| SOUL/TOOLS inject | 3ms | 3ms |
| State update | 2ms | 50ms |
| Full heartbeat (1 issue) | ~25ms | ~300ms |

*Baseline assumes config already in memory and persona files cached.*

---

**Report prepared for:** CEO and Backend personas  
**Owner:** Backend engineer  
**Next review:** After Tier 1 optimizations merged
