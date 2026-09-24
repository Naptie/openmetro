# Data quality

![Data quality](./quality.svg)

Generated from each network’s `network.json.quality` after data sync. Do not edit by hand — re-run `bun run data:sync` (or `scripts/write-quality-report.ts`).

_Updated 2026-09-24T19:42:56.049Z_

## 北京地铁 / Beijing Subway (`cn-beijing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=411, derived=15 |
| Names | ✅ complete | official | 100% | official=426 |
| Segment times | ✅ complete | official | 100% | official=487, derived=27, default=1 |
| Segment distances | ✅ complete | official | 100% | official=515 |
| Transfer times | 🟡 partial | official | 79% | official=116, derived=85, default=55 |
| Timetables | ✅ complete | official | 100% | official=1004 |
| Schematic | ✅ complete | official | 100% | official=543 |
| Fares | 🟡 partial | official | 99% | official=179352, default=1698 |

## 成都轨道交通 / Chengdu Rail Transit (`cn-chengdu`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=355, derived=34 |
| Names | ✅ complete | official | 100% | official=389 |
| Segment times | 🟠 derived | derived | 100% | official=158, derived=306 |
| Segment distances | ✅ complete | official | 100% | official=464 |
| Transfer times | 🟠 derived | derived | 100% | official=35, derived=165 |
| Timetables | ✅ complete | official | 100% | official=1018 |
| Schematic | 🟡 partial | official | 91% | official=437, default=44 |
| Fares | ✅ complete | official | 100% | official=150932 |

## 重庆轨道交通 / Chongqing Rail Transit (`cn-chongqing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=270, default=1 |
| Names | ✅ complete | official | 100% | official=271 |
| Segment times | ✅ complete | official | 100% | official=159, derived=152, default=1 |
| Segment distances | 🟡 partial | derived | 99% | derived=310, default=2 |
| Transfer times | 🟠 derived | derived | 100% | official=15, derived=107 |
| Timetables | ✅ complete | official | 100% | official=496 |
| Schematic | ❌ unavailable | default | 0% | default=325 |
| Fares | ❌ unavailable | default | 0% | default=73170 |

## 广州地铁 / Guangzhou Metro (`cn-guangzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=498, derived=5 |
| Names | ✅ complete | official | 100% | official=503 |
| Segment times | 🟠 derived | derived | 100% | official=269, derived=298 |
| Segment distances | 🟠 derived | derived | 100% | derived=567 |
| Transfer times | 🟡 partial | derived | 45% | official=41, derived=105, default=178 |
| Timetables | ✅ complete | official | 100% | official=1277 |
| Schematic | ❌ unavailable | default | 0% | default=599 |
| Fares | 🟡 partial | official | 94% | official=236520, default=15986 |

## 杭州地铁 / Hangzhou Metro (`cn-hangzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=260, derived=1 |
| Names | ✅ complete | official | 100% | official=261 |
| Segment times | ✅ complete | official | 100% | official=244, derived=55 |
| Segment distances | 🟠 derived | derived | 100% | derived=299 |
| Transfer times | 🟠 derived | derived | 100% | official=22, derived=82 |
| Timetables | ✅ complete | official | 100% | official=749 |
| Schematic | ✅ complete | official | 100% | official=308, default=1 |
| Fares | ✅ complete | official | 100% | official=67860 |

## 港鐵 / Mass Transit Railway (`cn-hongkong`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=97 |
| Names | ✅ complete | official | 100% | official=97 |
| Segment times | 🟠 derived | derived | 100% | derived=110 |
| Segment distances | 🟠 derived | derived | 100% | derived=110 |
| Transfer times | 🟠 derived | derived | 100% | derived=52 |
| Timetables | ✅ complete | official | 100% | official=311 |
| Schematic | ❌ unavailable | default | 0% | default=120 |
| Fares | 🟡 partial | official | 96% | official=8944, default=368 |

## 上海地铁 / Shanghai Metro (`cn-shanghai`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=417 |
| Names | ✅ complete | official | 100% | official=417 |
| Segment times | ✅ complete | official | 100% | official=516 |
| Segment distances | 🟡 partial | official | 22% | official=114, default=402 |
| Transfer times | ✅ complete | official | 100% | official=276 |
| Timetables | ✅ complete | official | 100% | official=1238 |
| Schematic | ❌ unavailable | default | 0% | default=530 |
| Fares | 🟡 partial | official | 99% | official=171212, default=2260 |

## 深圳地铁 / Shenzhen Metro (`cn-shenzhen`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=351 |
| Names | ✅ complete | official | 100% | official=351 |
| Segment times | ✅ complete | official | 100% | official=416 |
| Segment distances | 🟠 derived | derived | 100% | derived=416 |
| Transfer times | 🟡 partial | official | 86% | official=166, default=28 |
| Timetables | ✅ complete | official | 100% | official=829 |
| Schematic | ✅ complete | official | 100% | official=433 |
| Fares | ✅ complete | official | 100% | official=122850 |

## 苏州轨道交通 / Suzhou Rail Transit (`cn-suzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=235, derived=4 |
| Names | ✅ complete | official | 100% | official=239 |
| Segment times | 🟡 partial | official | 99% | official=266, default=4 |
| Segment distances | 🟡 partial | official | 99% | official=266, default=4 |
| Transfer times | 🟠 derived | derived | 100% | official=6, derived=74 |
| Timetables | ✅ complete | official | 100% | official=457 |
| Schematic | ✅ complete | official | 100% | official=279 |
| Fares | 🟡 partial | official | 97% | official=54990, default=1892 |

## 武汉地铁 / Wuhan Metro (`cn-wuhan`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ complete | official | 100% | official=1 |
| Coordinates | ✅ complete | official | 100% | official=289 |
| Names | ✅ complete | official | 100% | official=289 |
| Segment times | ✅ complete | official | 100% | official=322 |
| Segment distances | 🟡 partial | official | 42% | official=135, default=187 |
| Transfer times | ✅ complete | official | 100% | official=75, derived=25 |
| Timetables | ✅ complete | official | 100% | official=612 |
| Schematic | ✅ complete | official | 100% | official=335 |
| Fares | ✅ complete | official | 100% | official=83232 |

### Legend

| Status | Meaning |
| --- | --- |
| ✅ complete | Full coverage, official values |
| 🟡 partial | Some entities still use network defaults |
| 🟠 derived | Full coverage but only derived values |
| ❌ unavailable | No source values |

