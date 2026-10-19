# Data quality

![Data quality](./quality.svg)

Generated from each network’s stored quality metadata after data sync. Do not edit by hand — re-run `bun run data:sync` (or `scripts/write-quality-report.ts`).

_Updated 2026-10-16T08:01:24.762Z_

## 阿里山森林鐵路 / Alishan Forest Railway (`cn-alishan-railway`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | 🟠 Derived | derived | 100% | derived=18 |
| Names | 🟠 Derived | derived | 100% | derived=18 |
| Segment times | ✅ Complete | official | 100% | official=18, derived=2 |
| Segment distances | ✅ Complete | official | 100% | official=14, derived=6 |
| Transfer times | ❌ Unavailable | default | 0% | default=12 |
| Timetables | 🟡 Partial | official | 35% | official=14, derived=2, default=2, unknown_directions=22 |
| Schematic | ❌ Unavailable | default | 0% | default=21 |
| Fares | 🟡 Partial | official | 61% | official=188, default=118 |

## 北京地铁 / Beijing Subway (`cn-beijing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=411, derived=15 |
| Names | ✅ Complete | official | 100% | official=426 |
| Segment times | ✅ Complete | official | 100% | official=487, derived=27, default=1 |
| Segment distances | ✅ Complete | official | 100% | official=515 |
| Transfer times | 🟡 Partial | official | 79% | official=116, derived=85, default=55 |
| Timetables | ✅ Complete | official | 100% | official=1004 |
| Schematic | ✅ Complete | official | 100% | official=543 |
| Fares | 🟡 Partial | official | 99% | official=179352, default=1698 |

## 成都轨道交通 / Chengdu Rail Transit (`cn-chengdu`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=355, derived=34 |
| Names | ✅ Complete | official | 100% | official=389 |
| Segment times | 🟠 Derived | derived | 100% | official=158, derived=306 |
| Segment distances | ✅ Complete | official | 100% | official=464 |
| Transfer times | 🟡 Partial | official | 18% | official=35, default=165 |
| Timetables | ✅ Complete | official | 100% | official=1018 |
| Schematic | 🟡 Partial | official | 91% | official=437, default=44 |
| Fares | ✅ Complete | official | 100% | official=150932 |

## 重庆轨道交通 / Chongqing Rail Transit (`cn-chongqing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=270, default=1 |
| Names | ✅ Complete | official | 100% | official=271 |
| Segment times | 🟠 Derived | derived | 100% | derived=311, default=1 |
| Segment distances | 🟡 Partial | derived | 99% | derived=310, default=2 |
| Transfer times | 🟡 Partial | derived | 2% | derived=2, default=120 |
| Timetables | ✅ Complete | official | 100% | official=626 |
| Schematic | ❌ Unavailable | default | 0% | default=325 |
| Fares | 🟡 Partial | official | 98% | official=71544, default=1626 |

## 福州地铁 / Fuzhou Metro (`cn-fuzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=101 |
| Names | ✅ Complete | official | 100% | official=101 |
| Segment times | ✅ Complete | official | 100% | official=110 |
| Segment distances | 🟠 Derived | derived | 100% | derived=110 |
| Transfer times | ✅ Complete | official | 100% | official=32 |
| Timetables | ✅ Complete | official | 100% | official=232 |
| Schematic | ✅ Complete | official | 100% | official=116 |
| Fares | ✅ Complete | official | 100% | official=10100 |

## 广州地铁 / Guangzhou Metro (`cn-guangzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=498, derived=5 |
| Names | ✅ Complete | official | 100% | official=503 |
| Segment times | 🟠 Derived | derived | 100% | official=269, derived=298 |
| Segment distances | 🟠 Derived | derived | 100% | derived=567 |
| Transfer times | 🟡 Partial | derived | 45% | official=41, derived=105, default=178 |
| Timetables | ✅ Complete | official | 100% | official=1277 |
| Schematic | ❌ Unavailable | default | 0% | default=599 |
| Fares | 🟡 Partial | official | 94% | official=236520, default=15986 |

## 杭州地铁 / Hangzhou Metro (`cn-hangzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=260, derived=1 |
| Names | ✅ Complete | official | 100% | official=261 |
| Segment times | ✅ Complete | official | 100% | official=244, derived=55 |
| Segment distances | 🟠 Derived | derived | 100% | derived=299 |
| Transfer times | 🟡 Partial | official | 21% | official=22, default=82 |
| Timetables | ✅ Complete | official | 100% | official=749 |
| Schematic | ✅ Complete | official | 100% | official=308, default=1 |
| Fares | ✅ Complete | official | 100% | official=67860 |

## 港鐵 / Mass Transit Railway (`cn-hongkong`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=97 |
| Names | ✅ Complete | official | 100% | official=97 |
| Segment times | 🟠 Derived | derived | 100% | derived=110 |
| Segment distances | 🟠 Derived | derived | 100% | derived=110 |
| Transfer times | ❌ Unavailable | default | 0% | default=52 |
| Timetables | ✅ Complete | official | 100% | official=311 |
| Schematic | ❌ Unavailable | default | 0% | default=120 |
| Fares | 🟡 Partial | official | 96% | official=8944, default=368 |

## 济南轨道交通 / Jinan Rail Transit (`cn-jinan`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=143, derived=2 |
| Names | ✅ Complete | official | 100% | official=145 |
| Segment times | ✅ Complete | official | 100% | official=145, derived=3 |
| Segment distances | ✅ Complete | official | 100% | official=115, derived=33 |
| Transfer times | ✅ Complete | official | 100% | official=36 |
| Timetables | ✅ Complete | official | 100% | official=296 |
| Schematic | ✅ Complete | official | 100% | official=155 |
| Fares | ✅ Complete | official | 100% | official=20880 |

## 高雄捷運 / Kaohsiung Metro (`cn-kaohsiung`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | 🟠 Derived | derived | 100% | derived=76 |
| Names | ✅ Complete | official | 100% | official=76 |
| Segment times | ✅ Complete | official | 100% | official=76, derived=74 |
| Segment distances | 🟠 Derived | derived | 100% | derived=150 |
| Transfer times | 🟡 Partial | derived | 75% | derived=6, default=2 |
| Timetables | ✅ Complete | official | 100% | official=150 |
| Schematic | ❌ Unavailable | default | 0% | default=77 |
| Fares | 🟡 Partial | official | 49% | official=2812, default=2888 |

## 澳門輕軌 / Macau Light Rapid Transit (`cn-macau`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=15 |
| Names | ✅ Complete | official | 100% | official=15 |
| Segment times | 🟠 Derived | derived | 100% | derived=14 |
| Segment distances | 🟠 Derived | derived | 100% | derived=14 |
| Transfer times | ❌ Unavailable | default | 0% | default=4 |
| Timetables | ✅ Complete | official | 100% | official=28 |
| Schematic | ❌ Unavailable | default | 0% | default=17 |
| Fares | ✅ Complete | official | 100% | official=210 |

## 南京地铁 / Nanjing Metro (`cn-nanjing`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=240, derived=9 |
| Names | ✅ Complete | official | 100% | official=249 |
| Segment times | 🟠 Derived | derived | 100% | derived=269 |
| Segment distances | 🟠 Derived | derived | 100% | derived=269 |
| Transfer times | ❌ Unavailable | default | 0% | default=74 |
| Timetables | ✅ Complete | official | 100% | official=482 |
| Schematic | 🟡 Partial | official | 94% | official=267, default=16 |
| Fares | ✅ Complete | official | 100% | official=61752 |

## 青岛地铁 / Qingdao Metro (`cn-qingdao`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=176 |
| Names | ✅ Complete | official | 100% | official=176 |
| Segment times | ✅ Complete | official | 100% | official=186, derived=1 |
| Segment distances | ✅ Complete | official | 100% | official=186, derived=1 |
| Transfer times | ✅ Complete | official | 100% | official=42 |
| Timetables | ✅ Complete | official | 100% | official=374 |
| Schematic | ✅ Complete | official | 100% | official=195 |
| Fares | ✅ Complete | official | 100% | official=30800 |

## 上海地铁 / Shanghai Metro (`cn-shanghai`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=417 |
| Names | ✅ Complete | official | 100% | official=417 |
| Segment times | ✅ Complete | official | 100% | official=516 |
| Segment distances | 🟡 Partial | official | 22% | official=114, default=402 |
| Transfer times | ✅ Complete | official | 100% | official=276 |
| Timetables | ✅ Complete | official | 100% | official=1238 |
| Schematic | ❌ Unavailable | default | 0% | default=530 |
| Fares | 🟡 Partial | official | 99% | official=171212, default=2260 |

## 深圳地铁 / Shenzhen Metro (`cn-shenzhen`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=208, derived=142, default=1 |
| Names | ✅ Complete | official | 100% | official=351 |
| Segment times | 🟠 Derived | derived | 100% | derived=416 |
| Segment distances | 🟠 Derived | derived | 100% | derived=414, default=2 |
| Transfer times | ❌ Unavailable | default | 0% | default=194 |
| Timetables | ✅ Complete | official | 100% | official=835 |
| Schematic | ✅ Complete | official | 100% | official=433 |
| Fares | 🟡 Partial | official | 99% | official=122150, default=700 |

## 苏州轨道交通 / Suzhou Rail Transit (`cn-suzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | 🟡 Partial | official | 98% | official=231, derived=4, default=4 |
| Names | ✅ Complete | official | 100% | official=239 |
| Segment times | ✅ Complete | official | 100% | official=266, derived=4 |
| Segment distances | ✅ Complete | official | 100% | official=266, derived=4 |
| Transfer times | 🟡 Partial | derived | 3% | derived=2, default=78 |
| Timetables | ✅ Complete | official | 100% | official=534 |
| Schematic | ✅ Complete | official | 100% | official=279 |
| Fares | 🟡 Partial | official | 97% | official=54990, default=1892 |

## 臺中捷運 / Taichung Metro (`cn-taichung`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=18 |
| Names | ✅ Complete | official | 100% | official=18 |
| Segment times | 🟠 Derived | derived | 100% | derived=34 |
| Segment distances | ✅ Complete | official | 100% | official=34 |
| Transfer times | ❌ Unavailable | default | 0% | — |
| Timetables | ✅ Complete | official | 100% | official=34 |
| Schematic | ❌ Unavailable | default | 0% | default=18 |
| Fares | ✅ Complete | official | 100% | official=306 |

## 臺北都會區捷運 / Taipei Metropolitan MRT (`cn-taipei`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=109, derived=66 |
| Names | ✅ Complete | official | 100% | official=131, derived=44 |
| Segment times | 🟠 Derived | derived | 100% | official=45, derived=171 |
| Segment distances | 🟠 Derived | derived | 100% | derived=216 |
| Transfer times | 🟡 Partial | official | 78% | official=32, derived=26, default=16 |
| Timetables | ✅ Complete | official | 100% | official=378 |
| Schematic | ❌ Unavailable | default | 0% | default=200 |
| Fares | 🟡 Partial | official | 42% | official=12796, default=17654 |

## 台灣高鐵 / Taiwan High Speed Rail (`cn-taiwan-hsr`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | 🟠 Derived | derived | 100% | derived=12 |
| Names | 🟠 Derived | derived | 100% | derived=12 |
| Segment times | ✅ Complete | official | 100% | official=11 |
| Segment distances | 🟠 Derived | derived | 100% | derived=11 |
| Transfer times | ❌ Unavailable | default | 0% | — |
| Timetables | ✅ Complete | official | 100% | official=22 |
| Schematic | ❌ Unavailable | default | 0% | default=12 |
| Fares | ✅ Complete | official | 100% | official=132 |

## 台灣鐵路 / Taiwan Railway (`cn-taiwan-railway`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=240 |
| Names | ✅ Complete | official | 100% | official=240 |
| Segment times | ✅ Complete | official | 100% | official=242 |
| Segment distances | 🟠 Derived | derived | 100% | derived=242 |
| Transfer times | ❌ Unavailable | default | 0% | default=28 |
| Timetables | ✅ Complete | official | 100% | official=484 |
| Schematic | ❌ Unavailable | default | 0% | default=254 |
| Fares | ❌ Unavailable | default | 0% | default=57360 |

## 天津轨道交通 / Tianjin Rail Transit (`cn-tianjin`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=239 |
| Names | ✅ Complete | official | 100% | official=239 |
| Segment times | ✅ Complete | official | 100% | official=258, derived=3 |
| Segment distances | 🟠 Derived | derived | 100% | derived=261 |
| Transfer times | ✅ Complete | official | 100% | official=78 |
| Timetables | ✅ Complete | official | 100% | official=531 |
| Schematic | ✅ Complete | official | 100% | official=274 |
| Fares | 🟡 Partial | official | 92% | official=52302, default=4580 |

## 乌鲁木齐地铁 / Ürümqi Metro (`cn-urumqi`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=22 |
| Names | ✅ Complete | official | 100% | official=22 |
| Segment times | ✅ Complete | official | 100% | official=21 |
| Segment distances | ✅ Complete | official | 100% | official=21 |
| Transfer times | ❌ Unavailable | default | 0% | default=2 |
| Timetables | ✅ Complete | official | 100% | official=42 |
| Schematic | ✅ Complete | official | 100% | official=23 |
| Fares | 🟡 Partial | official | 91% | official=420, default=42 |

## 武汉地铁 / Wuhan Metro (`cn-wuhan`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=289 |
| Names | ✅ Complete | official | 100% | official=289 |
| Segment times | ✅ Complete | official | 100% | official=322 |
| Segment distances | 🟠 Derived | derived | 100% | derived=322 |
| Transfer times | 🟡 Partial | official | 72% | official=72, default=28 |
| Timetables | ✅ Complete | official | 100% | official=682 |
| Schematic | ✅ Complete | official | 100% | official=335 |
| Fares | ✅ Complete | official | 100% | official=83232 |

## 厦门地铁 / Xiamen Metro (`cn-xiamen`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=92 |
| Names | ✅ Complete | official | 100% | official=92 |
| Segment times | ✅ Complete | official | 100% | official=97 |
| Segment distances | 🟠 Derived | derived | 100% | derived=97 |
| Transfer times | ✅ Complete | official | 100% | official=20 |
| Timetables | ✅ Complete | official | 100% | official=194 |
| Schematic | ✅ Complete | official | 100% | official=102 |
| Fares | 🟡 Partial | official | 61% | official=5134, default=3238 |

## 西安地铁 / Xi'an Metro (`cn-xian`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=247, derived=1 |
| Names | ✅ Complete | official | 100% | official=248 |
| Segment times | ✅ Complete | official | 100% | official=274, derived=1 |
| Segment distances | 🟠 Derived | derived | 100% | derived=275 |
| Transfer times | ✅ Complete | official | 100% | official=82 |
| Timetables | ✅ Complete | official | 100% | official=553 |
| Schematic | 🟡 Partial | official | 99% | official=283, default=4 |
| Fares | ✅ Complete | official | 100% | official=61256 |

## 郑州地铁 / Zhengzhou Metro (`cn-zhengzhou`)

| Layer | Status | Precision | Coverage | Counts |
| --- | --- | --- | --- | --- |
| Topology | ✅ Complete | official | 100% | official=1 |
| Coordinates | ✅ Complete | official | 100% | official=233, derived=2 |
| Names | ✅ Complete | official | 100% | official=235 |
| Segment times | ✅ Complete | official | 100% | official=274, default=1 |
| Segment distances | ✅ Complete | official | 100% | official=274, default=1 |
| Transfer times | 🟡 Partial | official | 96% | official=104, default=4 |
| Timetables | ✅ Complete | official | 100% | official=544 |
| Schematic | 🟡 Partial | official | 99% | official=285, default=2 |
| Fares | 🟡 Partial | official | 99% | official=54522, default=468 |

### Legend

| Status | Meaning |
| --- | --- |
| ✅ complete | Full coverage, official values |
| 🟡 partial | Some values are missing, unresolved, or use defaults |
| 🟠 derived | Full coverage but only derived values |
| ❌ unavailable | No source values |

