# Taichung / Kaohsiung review fixes implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation; run one independent final review. Steps use checkboxes.

**Goal:** Fix the five confirmed review findings and regenerate both cities exclusively through their live adapters.
**Architecture:** Use current operator service times and additive differences of terminal-to-station journey durations. Keep raw running/dwell metrics as diagnostics, mark inferred edge weights as derived, and check them against complete official journeys. Verify OSM mode/operator/ref before accepting a coordinate; validate every stop's expected service directions before writes.
**Tech Stack:** TypeScript, Bun, existing canonical schema and adapters.
**Spec:** User request in this chat: fix all five findings in the original worktree, regenerate automatically, test cold acquisition/missing directions/official complete-trip durations; do not merge or touch other worktrees.

## Constraints and rulings
- Only work in C:/Users/yuhaofeng/.codex/worktrees/taichung-kaohsiung/openmetro.
- No manual canonical edits; no merge/push. The user subsequently authorized a commit on the current branch after a second independent review.
- Existing tests' Qingdao external fixture dependency is not part of these fixes.
- Ruling: use live cumulative operator journey times for Taichung rather than extending the routing schema for dwell. The operator journey includes intermediate stops; differencing avoids per-edge rounding accumulation and preserves the existing graph contract. Explicitly record quantization/tolerance and derived precision.

## Review focus
- Missing one direction/day or duplicated identity must fail before canonical writes.
- Live journeys must match topology and supply every anchor needed; nonpositive differences fail.
- Same-name TRA/subway/LRT POIs must be separated by mode and official ref.
- Cold runs must not read historical worktree source files; validation outputs go to scratch.
- Default refresh must retain prior fares; full cold fare harvesting must supply every system-internal pair.

## Tasks
- [x] 1. Add regression tests for current Taichung service fields, cumulative travel durations, missing/repeated directions, malformed inputs; watch them fail. Update fetch/normalize and fixtures from live official data; rerun tests.
- [x] 2. Add Kaohsiung cumulative-journey tests and directional coverage tests; watch them fail. Fetch terminal anchors, derive directional edge times and validate official journeys within one minute; rerun tests.
- [x] 3. Add railway identity tests (TRA collision, official ref/mode, bbox); watch them fail. Verify Photon candidates through OSM API metadata; reject ambiguous/mismatched candidates; rerun tests.
- [x] 4. Add reproducible live verification script for cold acquisition, all fare coverage, official full-trip comparisons and missing-direction mutations. Run against an empty scratch cache, generate the two canonical cities through normal sync, update API bundle/quality report through generators.
- [x] 5. Run build, typecheck, lint, tests, all-data verification, API smoke and final independent review; confirm scope and record limitations. No merge.

## Execution ledger
- Baseline: 58b69ce, clean. Review already established all five root causes.

- TDD evidence: 5 normalization regressions failed first; all passed after live-service/cumulative-time changes. Railway identity tests failed before implementation and pass. Both strict verify-data mutation tests first exited 0 (failure), now reject missing direction.
- Full cold acquisition: OS temp openmetro-taiwan-cold-yc8KSD, 1446 KRTC queries, 1406 internal fare pairs, TC 306 official directed journeys, correct C18 N/8057987302. No historical worktree cache read.
- Generated canonical through data:sync for each city with topology,timetables,enrichment,fares; no hand edits. Updated API bundle with build-worker-data.ts.
- Build/typecheck/lint passed; full suite151 pass. Local ignored inlang .meta.json newline normalized to remove an existing lint artifact.
- Independent review found stale shipped-data124/127s assertions; replaced with150s and official2130s wholejourney regression, then full suite passed. No additional source regression reported.
- Ruling: line extras explicitly opt into all_stop_directions verifier contract, so these adapters fail on partial service while legacy branching city semantics remain unchanged.

- Previous-turn acceptance: all22 canonical networks verified, no Taichung/Kaohsiung warnings. Default Kaohsiung refresh preserved exact1406-pair fare matrix and every prior source/retrieved_at. Post-refresh shipped-data and verifier mutation tests4/4 passed. All tracked data changes limited to these2 cities and generated quality summaries. HEAD remains58b69ce; no commit/push/merge.
- Reproduction: bun run scripts/verify-taiwan-adapters.ts --fares (fresh OS cache each run); bun test; bun run data:verify; bun run build; bun run typecheck; bun run lint. Full cold report: C:/Users/YUHAOF~1/AppData/Local/Temp/openmetro-taiwan-cold-yc8KSD/report.json. Local final data manifest/log: tmp/review-fixes/data-manifest.json and data-verify.log.

- Second review requested by user before commit. Fresh precommit verification: build, typecheck, lint,151tests,22-network data verification and4API smoke routes all passed; both city datasets have no verify warnings. Canonical changes are limited to the2 cities plus generated quality reports.

- Second independent review: no actionable regression;23focusedtests passed. Actual graph comparisons covered306TC journeys and109KH topology quotes, max60s. Missing/duplicate directions/daytypes, malformed service fields, duplicate identities/journeys and invalid/nonmonotonic anchors rejected. Full1446query live acquisition was not repeated in the second review; earlier report remains the evidence (sources.json was subsequently overwritten by default refresh). Approved for current-branch commit; no merge/push.
