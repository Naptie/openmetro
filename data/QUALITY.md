# Data quality

![Data quality](./quality.svg)

Generated from each network’s `network.json.quality` after data sync. Do not edit by hand — re-run `bun run data:sync` (or `scripts/write-quality-report.ts`).

_Updated 2026-09-20T16:22:57.894Z_

## 北京地铁 / Beijing Subway (`cn-beijing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=411, derived=15 |
| Names | ✅ complete | official | 100% | official=426 |
| Segment times | ✅ complete | official | 100% | official=495, derived=20 |
| Segment distances | ✅ complete | official | 100% | official=515 |
| Transfer times | 🟡 partial | official | 78% | official=114, derived=85, default=57 |
| Timetables | ✅ complete | official | 100% | official=1004 |
| Schematic | ✅ complete | official | 100% | official=543 |
| Fares | 🟡 partial | official | 99% | official=179352, default=1698 |

## 广州地铁 / Guangzhou Metro (`cn-guangzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=498, derived=5 |
| Names | ✅ complete | official | 100% | official=503 |
| Segment times | 🟡 partial | derived | 84% | derived=475, default=92 |
| Segment distances | ❌ unavailable | default | 0% | default=567 |
| Transfer times | 🟡 partial | derived | 33% | derived=106, default=218 |
| Timetables | ✅ complete | official | 100% | official=1277 |
| Schematic | ❌ unavailable | default | 0% | default=599 |
| Fares | 🟡 partial | official | 94% | official=236520, default=15986 |

## 上海地铁 / Shanghai Metro (`cn-shanghai`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=417 |
| Names | ✅ complete | official | 100% | official=417 |
| Segment times | ✅ complete | official | 100% | official=516 |
| Segment distances | ❌ unavailable | default | 0% | default=516 |
| Transfer times | ✅ complete | official | 100% | official=276 |
| Timetables | ✅ complete | official | 100% | official=1241 |
| Schematic | ❌ unavailable | default | 0% | default=530 |
| Fares | 🟡 partial | official | 99% | official=171212, default=2260 |

## 深圳地铁 / Shenzhen Metro (`cn-shenzhen`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=351 |
| Names | ✅ complete | official | 100% | official=351 |
| Segment times | ✅ complete | official | 100% | official=416 |
| Segment distances | ✅ complete | official | 100% | official=416 |
| Transfer times | 🟡 partial | official | 82% | official=160, default=34 |
| Timetables | ✅ complete | official | 100% | official=660 |
| Schematic | ✅ complete | official | 100% | official=433 |
| Fares | 🟡 partial | official | 99% | official=121452, default=1398 |

## 苏州轨道交通 / Suzhou Rail Transit (`cn-suzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=235, derived=4 |
| Names | ✅ complete | official | 100% | official=239 |
| Segment times | 🟡 partial | official | 99% | official=266, default=4 |
| Segment distances | 🟡 partial | official | 99% | official=266, default=4 |
| Transfer times | 🟠 derived | derived | 100% | derived=80 |
| Timetables | ✅ complete | official | 100% | official=457 |
| Schematic | ✅ complete | official | 100% | official=279 |
| Fares | — | — | — | — |

### Legend

| Status | Meaning |
| --- | --- |
| ✅ complete | Full coverage, official values |
| 🟡 partial | Some entities still use network defaults |
| 🟠 derived | Full coverage but only derived values |
| ❌ unavailable | No source values |

