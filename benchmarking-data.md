# PayFlow benchmarking data

Generated from the metadata-backed candidate runs in `benchmarking-candidates/`.

Runs included: **80**.

Cost handling:

- `Est cost (USD)` uses the HackerRank OpenHands Gateway `pricing.py` logic and `pricing.json` rates. It prefers per-request gateway usage and falls back to aggregate OpenHands usage.
- `Reported cost (USD)` uses the reported Gateway cost first, then the reported OpenHands cost. `—` means neither reported a cost; the independent estimate remains in `Est cost (USD)`.
- `Tests` is passed/total from the hidden JUnit report.
- `LOC total` is the number of changed lines reported by telemetry.
- `—` means the source run did not provide that measurement.

| Run name | Model | Reasoning | Score | Tokens (in/out/r/cache) | Est cost (USD) | Reported cost (USD) | Duration | Files total | LOC total | Tests | Deps | Largest file | Tool calls | Tool calls failed | Events | Cache hit rate | Status |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
| minimax-m3-medium-20260917t093420z | minimax-m3 | medium | 0.1749 | 30.3M/121.7K/1.3K/29.5M | $4.3169 | $2.1584 | 1h 17m 29s | 15 | 1062 | 4/13 | 17 | package-lock.json (124.0KB) | 493 | 4 | 1000 | 97.3% | completed |
| openai-claude-opus-5-high-20260915t131229z | claude-opus-5 | high | 0.2624 | 18.1M/280.6K/143.3K/0 | $292.7367 | — | 1h 16m 38s | 23 | 987 | 4/13 | 17 | package-lock.json (124.0KB) | 139 | 9 | 296 | 0.0% | completed |
| openai-claude-opus-5-high-20260915t150106z | claude-opus-5 | high | 0.0750 | 1.3M/112.8K/108.5K/0 | $27.2575 | — | 25m 58s | 0 | 0 | 4/13 | 17 | package-lock.json (124.0KB) | 26 | 0 | 68 | 0.0% | completed |
| openai-claude-opus-5-high-20260917t193741z | claude-opus-5 | high | 0.2624 | 40.4M/791.7K/613.8K/0 | $665.5406 | — | 3h 47m 7s | 22 | 1367 | 5/13 | 17 | package-lock.json (124.0KB) | 491 | 6 | 1013 | 0.0% | completed |
| openai-claude-opus-5-medium-20260915t054120z | claude-opus-5 | medium | 0.2624 | 25.6M/305.8K/144.1K/0 | $406.4171 | — | 1h 21m 57s | 24 | 1680 | 5/13 | 17 | package-lock.json (124.0KB) | 175 | 9 | 372 | 0.0% | completed |
| openai-claude-opus-5-medium-20260915t074453z | claude-opus-5 | medium | 0.2624 | 19.0M/290.4K/143.0K/0 | $306.0386 | — | 1h 20m 10s | 27 | 1820 | 5/13 | 17 | package-lock.json (124.0KB) | 131 | 10 | 280 | 0.0% | completed |
| openai-claude-opus-5-medium-20260915t110250z | claude-opus-5 | medium | 0.2437 | 16.3M/178.5K/121.6K/0 | $258.5646 | — | 53m 49s | 23 | 1248 | 4/13 | 17 | package-lock.json (124.0KB) | 123 | 5 | 253 | 0.0% | completed |
| openai-claude-sonnet-5-high-20260915t131223z | claude-sonnet-5 | high | 0.1937 | 25.8M/123.4K/60.2K/0 | $79.1865 | — | 38m 13s | 10 | 515 | 4/13 | 17 | package-lock.json (124.0KB) | 208 | 4 | 424 | 0.0% | completed |
| openai-claude-sonnet-5-high-20260915t150107z | claude-sonnet-5 | high | 0.2437 | 59.2M/300.0K/207.7K/0 | $182.2494 | — | 1h 33m 45s | 22 | 846 | 4/13 | 17 | package-lock.json (124.0KB) | 280 | 13 | 568 | 0.0% | completed |
| openai-claude-sonnet-5-high-20260915t165237z | claude-sonnet-5 | high | 0.2124 | 36.0M/287.8K/194.3K/0 | $112.4538 | — | 1h 21m 52s | 17 | 647 | 4/13 | 17 | package-lock.json (124.0KB) | 242 | 5 | 496 | 0.0% | completed |
| openai-claude-sonnet-5-medium-20260915t054120z | claude-sonnet-5 | medium | 0.1563 | 29.6M/350.8K/289.9K/0 | $94.0332 | — | 1h 22m 54s | 17 | 727 | 4/13 | 17 | package-lock.json (124.0KB) | 241 | 8 | 498 | 0.0% | completed |
| openai-claude-sonnet-5-medium-20260915t074451z | claude-sonnet-5 | medium | 0.2311 | 24.5M/203.4K/139.1K/0 | $76.5322 | — | 53m 5s | 12 | 466 | 4/13 | 17 | package-lock.json (124.0KB) | 220 | 8 | 450 | 0.0% | completed |
| openai-claude-sonnet-5-medium-20260915t095001z | claude-sonnet-5 | medium | 0.2124 | 15.8M/69.2K/16.6K/0 | $48.3188 | — | 25m 29s | 15 | 560 | 4/13 | 17 | package-lock.json (124.0KB) | 156 | 5 | 318 | 0.0% | completed |
| openai-deepseek-v4-pro-high-20260916t132951z | deepseek-v4-pro | high | 0.1562 | 3.5M/44.1K/23.6K/3.3M | $0.2661 | $1.0051 | 15m 37s | 6 | 492 | 4/13 | 17 | package-lock.json (124.0KB) | 110 | 0 | 227 | 95.4% | completed |
| openai-deepseek-v4-pro-high-20260917t145202z | deepseek-v4-pro | high | 0.1250 | 10.0M/66.5K/38.4K/9.5M | $0.6802 | $2.7581 | 23m 56s | 11 | 488 | 4/13 | 17 | package-lock.json (124.0KB) | 177 | 7 | 363 | 94.9% | completed |
| openai-deepseek-v4-pro-high-20260917t154618z | deepseek-v4-pro | high | 0.1562 | 8.6M/56.9K/29.5K/7.8M | $0.8097 | $2.9872 | 24m 50s | 14 | 545 | 4/13 | 17 | package-lock.json (124.0KB) | 160 | 2 | 329 | 90.7% | completed |
| openai-deepseek-v4-pro-medium-20260916t021346z | deepseek-v4-pro | medium | 0.1811 | 2.3M/21.0K/0/2.1M | $0.2126 | — | 6m 49s | — | — | 4/13 | 17 | package-lock.json (124.0KB) | 138 | 0 | — | 91.6% | completed |
| openai-deepseek-v4-pro-medium-20260916t141328z | deepseek-v4-pro | medium | 0.1437 | 9.6M/64.4K/35.3K/8.2M | $1.2280 | $4.2205 | 32m 12s | 8 | 435 | 4/13 | 17 | package-lock.json (124.0KB) | 158 | 0 | 323 | 85.5% | completed |
| openai-deepseek-v4-pro-medium-20260916t145041z | deepseek-v4-pro | medium | 0.1062 | 4.2M/72.1K/48.1K/2.9M | $1.0669 | $3.1587 | 22m 33s | 12 | 554 | 4/13 | 17 | package-lock.json (124.0KB) | 121 | 2 | 250 | 69.3% | completed |
| openai-gemini-3.7-flash-high-20260916t204412z | gemini-3.7-flash | high | 0.2624 | 19.8M/34.7K/0/18.0M | $1.9615 | — | 15m 23s | 15 | 845 | 5/13 | 17 | package-lock.json (124.0KB) | 159 | 2 | 324 | 91.2% | completed |
| openai-gemini-3.7-flash-high-20260917t064042z | gemini-3.7-flash | high | 0.2124 | 49.9M/66.6K/0/47.7M | $4.4124 | — | 28m 29s | 17 | 868 | 4/13 | 17 | package-lock.json (124.0KB) | 231 | 1 | 468 | 95.5% | completed |
| openai-gemini-3.7-flash-high-20260917t141820z | gemini-3.7-flash | high | 0.2249 | 19.3M/44.7K/0/17.4M | $1.9884 | — | 20m 11s | 17 | 956 | 4/13 | 17 | package-lock.json (124.0KB) | 187 | 2 | 382 | 90.1% | completed |
| openai-gemini-3.7-flash-medium-20260916t182111z | gemini-3.7-flash | medium | 0.1937 | 28.1M/33.3K/0/26.3M | $2.5914 | — | 25m 59s | 21 | 971 | 5/13 | 17 | package-lock.json (124.0KB) | 167 | 1 | 340 | 93.7% | completed |
| openai-gemini-3.7-flash-medium-20260916t221449z | gemini-3.7-flash | medium | 0.2124 | 18.4M/29.8K/0/16.5M | $1.8855 | — | 15m 8s | 14 | 957 | 4/13 | 17 | package-lock.json (124.0KB) | 141 | 1 | 288 | 89.6% | completed |
| openai-gemini-3.7-flash-medium-20260917t134628z | gemini-3.7-flash | medium | 0.2624 | 18.9M/37.5K/0/17.5M | $1.8405 | — | 21m 6s | 16 | 980 | 4/13 | 17 | package-lock.json (124.0KB) | 159 | 2 | 325 | 92.3% | completed |
| openai-glm-5.2-high-20260916t143002z | glm-5.2 | high | 0.2437 | 13.9M/119.5K/65.3K/13.8M | $4.2416 | $4.2416 | 25m 7s | 16 | 764 | 4/13 | 17 | package-lock.json (124.0KB) | 165 | 5 | 336 | 99.3% | completed |
| openai-glm-5.2-high-20260917t120953z | glm-5.2 | high | 0.2563 | 19.5M/96.6K/14.1K/18.3M | $6.8297 | $4.6353 | 51m 41s | 18 | 1152 | 4/13 | 17 | package-lock.json (124.0KB) | 323 | 8 | 656 | 94.0% | completed |
| openai-glm-5.2-high-20260917t125001z | glm-5.2 | high | 0.2624 | 21.5M/112.0K/16.9K/21.1M | $6.5712 | $6.5712 | 24m 35s | 20 | 952 | 4/13 | 17 | package-lock.json (124.0KB) | 369 | 7 | 749 | 98.0% | completed |
| openai-glm-5.2-medium-20260916t130921z | glm-5.2 | medium | 0.2311 | 12.8M/48.8K/2.7K/12.6M | $3.7691 | $3.7691 | 27m 23s | 8 | 504 | 4/13 | 17 | package-lock.json (124.0KB) | 156 | 2 | 318 | 98.5% | completed |
| openai-glm-5.2-medium-20260917t115228z | glm-5.2 | medium | 0.2250 | 8.3M/71.1K/27.9K/8.1M | $2.6159 | $2.6159 | 14m 31s | 17 | 797 | 4/13 | 17 | package-lock.json (124.0KB) | 128 | 1 | 263 | 98.3% | completed |
| openai-glm-5.2-medium-20260917t132337z | glm-5.2 | medium | 0.2624 | 17.2M/108.6K/32.2K/16.9M | $5.2339 | $5.2339 | 21m 41s | 19 | 861 | 4/13 | 17 | package-lock.json (124.0KB) | 239 | 3 | 486 | 98.5% | completed |
| openai-gpt-5.6-luna-high-20260915t034206z | gpt-5.6-luna | high | 0.1562 | 3.4M/38.7K/0/0 | $4.6802 | $0.1434 | 7m 52s | 13 | 473 | 4/13 | 17 | package-lock.json (124.0KB) | 167 | 9 | 340 | 0.0% | completed |
| openai-gpt-5.6-luna-high-20260915t040235z | gpt-5.6-luna | high | 0.0875 | 3.4M/46.2K/0/0 | $4.7038 | $0.1484 | 10m 10s | 16 | 580 | 4/13 | 17 | package-lock.json (124.0KB) | 140 | 8 | 286 | 0.0% | completed |
| openai-gpt-5.6-luna-high-20260915t121359z | gpt-5.6-luna | high | 0.0937 | 9.2M/51.2K/0/0 | $12.0463 | $0.2827 | 15m 4s | 18 | 622 | 2/7 | 17 | package-lock.json (124.0KB) | 126 | 4 | 258 | 0.0% | completed |
| openai-gpt-5.6-luna-medium-20260915t121400z | gpt-5.6-luna | medium | 0.0625 | 1.6M/13.2K/0/0 | $2.1101 | $0.0636 | 3m 54s | 8 | 203 | 4/13 | 17 | package-lock.json (124.0KB) | 70 | 3 | 147 | 0.0% | completed |
| openai-gpt-5.6-luna-medium-20260915t124815z | gpt-5.6-luna | medium | 0.0875 | 1.6M/15.4K/0/0 | $2.1981 | $0.0668 | 4m 18s | 8 | 172 | 4/13 | 17 | package-lock.json (124.0KB) | 49 | 1 | 105 | 0.0% | completed |
| openai-gpt-5.6-luna-medium-20260915t125805z | gpt-5.6-luna | medium | 0.0875 | 1.3M/10.2K/0/0 | $1.7050 | $0.0517 | 3m 30s | 7 | 215 | 4/13 | 17 | package-lock.json (124.0KB) | 64 | 5 | 135 | 0.0% | completed |
| openai-gpt-5.6-sol-high-20260916t131359z | gpt-5.6-sol | high | 0.2624 | 17.7M/73.1K/0/0 | $22.8265 | $9.5667 | 36m 16s | 20 | 843 | 5/13 | 17 | package-lock.json (124.0KB) | 195 | 5 | 396 | 0.0% | completed |
| openai-gpt-5.6-sol-high-20260916t143003z | gpt-5.6-sol | high | 0.3312 | 10.5M/61.0K/0/0 | $13.7953 | $6.4233 | 26m 48s | 23 | 929 | 4/13 | 17 | package-lock.json (124.0KB) | 158 | 1 | 322 | 0.0% | completed |
| openai-gpt-5.6-sol-high-20260917t110639z | gpt-5.6-sol | high | 0.2624 | 8.9M/63.7K/0/0 | $11.8166 | $6.3467 | 28m 25s | 20 | 965 | 4/13 | 17 | package-lock.json (124.0KB) | 196 | 2 | 400 | 0.0% | completed |
| openai-gpt-5.6-sol-medium-20260916t131925z | gpt-5.6-sol | medium | 0.2624 | 5.0M/35.3K/0/0 | $6.6555 | $3.3267 | 13m 53s | 17 | 564 | 4/13 | 17 | package-lock.json (124.0KB) | 104 | 3 | 214 | 0.0% | completed |
| openai-gpt-5.6-sol-medium-20260916t134838z | gpt-5.6-sol | medium | 0.2250 | 6.1M/29.7K/0/0 | $7.9537 | $3.6750 | 15m 3s | 14 | 423 | 4/13 | 17 | package-lock.json (124.0KB) | 98 | 1 | 202 | 0.0% | completed |
| openai-gpt-5.6-sol-medium-20260916t143004z | gpt-5.6-sol | medium | 0.2624 | 5.5M/31.9K/0/0 | $7.2317 | $3.4589 | 13m 45s | 16 | 509 | 5/13 | 17 | package-lock.json (124.0KB) | 77 | 4 | 160 | 0.0% | completed |
| openai-gpt-5.6-terra-high-20260915t034202z | gpt-5.6-terra | high | 0.2249 | 2.0M/33.3K/0/0 | $2.8247 | $0.9957 | 7m 42s | 13 | 417 | 4/13 | 17 | package-lock.json (124.0KB) | 97 | 0 | 200 | 0.0% | completed |
| openai-gpt-5.6-terra-high-20260915t040237z | gpt-5.6-terra | high | 0.2311 | 4.5M/46.4K/0/0 | $6.0374 | $1.7878 | 12m 41s | 14 | 412 | 6/13 | 17 | package-lock.json (124.0KB) | 139 | 2 | 284 | 0.0% | completed |
| openai-gpt-5.6-terra-high-20260915t091802z | gpt-5.6-terra | high | 0.2124 | 5.4M/44.1K/0/0 | $7.2431 | $2.0324 | 18m 9s | 12 | 367 | 4/13 | 17 | package-lock.json (124.0KB) | 135 | 4 | 277 | 0.0% | completed |
| openai-gpt-5.6-terra-medium-20260914t204720z | gpt-5.6-terra | medium | 0.1936 | 1.6M/23.4K/0/0 | $2.2856 | $0.8065 | 4m 50s | 13 | 312 | 4/13 | 17 | package-lock.json (124.0KB) | 91 | 3 | 189 | 0.0% | completed |
| openai-gpt-5.6-terra-medium-20260915t050430z | gpt-5.6-terra | medium | 0.1562 | 1.6M/16.0K/0/0 | $2.0992 | $0.6444 | 4m 11s | 12 | 252 | 4/13 | 17 | package-lock.json (124.0KB) | 43 | 0 | 93 | 0.0% | completed |
| openai-gpt-5.6-terra-medium-20260915t091759z | gpt-5.6-terra | medium | 0.1562 | 1.4M/17.9K/0/0 | $1.9450 | $0.6619 | 4m 54s | 11 | 216 | 4/13 | 17 | package-lock.json (124.0KB) | 70 | 2 | 146 | 0.0% | completed |
| openai-grok-4.5-high-20260917t145835z | grok-4.5 | high | 0.2250 | 6.6M/61.0K/9.1K/6.0M | $3.4187 | $3.4187 | 23m 4s | 19 | 1394 | 4/13 | 17 | package-lock.json (124.0KB) | 110 | 3 | 227 | 90.6% | completed |
| openai-grok-4.5-high-20260917t150938z | grok-4.5 | high | 0.2937 | 3.4M/43.6K/8.2K/2.3M | $3.2039 | $3.2039 | 15m 7s | 17 | 958 | 4/13 | 17 | package-lock.json (124.0KB) | 81 | 4 | 169 | 67.5% | completed |
| openai-grok-4.5-high-20260917t151727z | grok-4.5 | high | 0.1563 | 3.1M/42.3K/7.5K/2.7M | $1.8542 | $1.8542 | 13m 46s | 17 | 1043 | 4/13 | 17 | package-lock.json (124.0KB) | 102 | 1 | 211 | 87.4% | completed |
| openai-grok-4.5-medium-20260917t152611z | grok-4.5 | medium | 0.1624 | 5.7M/60.5K/10.3K/5.0M | $3.3295 | $3.3295 | 20m 49s | 22 | 1101 | 4/13 | 17 | package-lock.json (124.0KB) | 90 | 2 | 187 | 87.0% | completed |
| openai-grok-4.5-medium-20260917t152947z | grok-4.5 | medium | 0.2311 | 3.2M/42.6K/10.5K/2.9M | $1.6094 | $1.6094 | 15m 16s | 16 | 1053 | 4/13 | 17 | package-lock.json (124.0KB) | 64 | 4 | 135 | 92.4% | completed |
| openai-grok-4.5-medium-20260917t154823z | grok-4.5 | medium | 0.2249 | 8.3M/52.8K/5.2K/7.6M | $3.9704 | $3.9704 | 23m 28s | 17 | 1319 | 4/13 | 17 | package-lock.json (124.0KB) | 83 | 4 | 173 | 91.8% | completed |
| openai-grok-4.6-high-20260915t043516z | grok-4.6 | high | 0.2250 | 7.0M/109.7K/0/0 | $14.5704 | — | 21m 1s | 22 | 1106 | 4/13 | 17 | package-lock.json (124.0KB) | 227 | 8 | 461 | 0.0% | completed |
| openai-grok-4.6-high-20260915t074451z | grok-4.6 | high | 0.1875 | 4.9M/105.8K/0/0 | $10.4231 | — | 17m 37s | 25 | 899 | 4/13 | 17 | package-lock.json (124.0KB) | 170 | 11 | 347 | 0.0% | completed |
| openai-grok-4.6-high-20260915t095000z | grok-4.6 | high | 0.0625 | 3.9M/111.7K/0/0 | $8.3831 | — | 19m 35s | 22 | 958 | 4/13 | 17 | package-lock.json (124.0KB) | 174 | 3 | 355 | 0.0% | completed |
| openai-grok-4.6-medium-20260915t091803z | grok-4.6 | medium | 0.1875 | 5.5M/128.0K/0/0 | $11.7329 | — | 20m 59s | 22 | 1270 | 4/13 | 17 | package-lock.json (124.0KB) | 199 | 4 | 405 | 0.0% | completed |
| openai-grok-4.6-medium-20260915t110255z | grok-4.6 | medium | 0.2249 | 3.9M/139.4K/0/0 | $8.5523 | — | 20m 40s | 23 | 1019 | 4/13 | 17 | package-lock.json (124.0KB) | 177 | 3 | 361 | 0.0% | completed |
| openai-grok-4.6-medium-20260915t121359z | grok-4.6 | medium | 0.2249 | 4.7M/101.5K/0/0 | $9.9481 | — | 19m 23s | 24 | 1081 | 4/13 | 17 | package-lock.json (124.0KB) | 195 | 3 | 397 | 0.0% | completed |
| openai-kimi-k3-high-20260916t122038z | kimi-k3 | high | 0.2624 | 10.7M/73.6K/38.0K/10.7M | $4.3384 | $4.3384 | 27m 14s | 18 | 821 | 4/13 | 17 | package-lock.json (124.0KB) | 146 | 3 | 298 | 100.0% | completed |
| openai-kimi-k3-high-20260916t125213z | kimi-k3 | high | 0.2311 | 6.8M/52.1K/24.4K/6.8M | $2.8204 | $2.8204 | 24m 13s | 19 | 637 | 4/13 | 17 | package-lock.json (124.0KB) | 123 | 2 | 252 | 100.0% | completed |
| openai-kimi-k3-high-20260916t143000z | kimi-k3 | high | 0.2124 | 6.6M/63.6K/33.0K/6.6M | $2.9641 | $2.9641 | 44m 53s | 18 | 677 | 4/13 | 17 | package-lock.json (124.0KB) | 116 | 3 | 238 | 99.9% | completed |
| openai-kimi-k3-medium-20260916t021346z | kimi-k3 | medium | 0.1937 | 32.2M/152.2K/81.8K/32.1M | $11.9408 | — | 41m 36s | — | — | 4/13 | 17 | package-lock.json (124.0KB) | 438 | 1 | — | 100.0% | completed |
| openai-kimi-k3-medium-20260916t122037z | kimi-k3 | medium | 0.2250 | 4.1M/31.1K/11.0K/4.1M | $1.7006 | $1.7006 | 11m 59s | 14 | 675 | 4/13 | 17 | package-lock.json (124.0KB) | 79 | 3 | 164 | 99.9% | completed |
| openai-kimi-k3-medium-20260916t143002z | kimi-k3 | medium | 0.2311 | 3.9M/28.7K/9.7K/3.9M | $1.6252 | $1.6252 | 14m 33s | 13 | 432 | 4/13 | 17 | package-lock.json (124.0KB) | 87 | 4 | 181 | 99.8% | completed |
| openai-minimax-m3-high-20260917t130311z | minimax-m3 | high | 0.1562 | 17.4M/63.9K/1.3K/16.1M | $2.8682 | $1.4341 | 1h 11m 2s | 10 | 533 | 4/13 | 17 | package-lock.json (124.0KB) | 343 | 7 | 696 | 92.6% | completed |
| openai-minimax-m3-high-20260917t131302z | minimax-m3 | high | 0.1562 | 25.5M/104.4K/2.4K/23.4M | $4.2974 | $2.1487 | 1h 55m 21s | 11 | 883 | 4/13 | 17 | package-lock.json (124.0KB) | 493 | 6 | 1000 | 91.9% | completed |
| openai-minimax-m3-high-20260917t153225z | minimax-m3 | high | 0.2062 | 16.4M/59.1K/1.2K/14.8M | $2.8630 | $1.4315 | 1h 4m 34s | 15 | 842 | 4/13 | 17 | package-lock.json (124.0KB) | 296 | 1 | 601 | 90.4% | completed |
| openai-minimax-m3-medium-20260917t051849z | minimax-m3 | medium | 0.1937 | 25.5M/80.6K/25/25.0M | $3.4771 | $1.7386 | 1h 7m 53s | 18 | 1052 | 4/13 | 17 | package-lock.json (124.0KB) | 248 | 1 | 502 | 98.2% | completed |
| openai-minimax-m3-medium-20260917t110834z | minimax-m3 | medium | 0.2374 | 27.5M/95.4K/1.6K/24.9M | $4.7618 | $2.3809 | 1h 39m 8s | 13 | 639 | 4/13 | 17 | package-lock.json (124.0KB) | 493 | 13 | 1000 | 90.6% | completed |
| openai-qwen-3.8-high-20260917t183836z | qwen-3.8 | high | 0.2250 | 28.7M/641.0K/535.0K/27.8M | $61.2714 | $12.5706 | 2h 44m 56s | 16 | 854 | 4/13 | 17 | package-lock.json (124.0KB) | 465 | 18 | 955 | 96.9% | completed |
| openai-qwen-3.8-high-20260917t202525z | qwen-3.8 | high | 0.0750 | 20.7M/1.2M/1.1M/19.3M | $48.5548 | $14.5462 | 3h 9m 36s | 7 | 671 | 4/13 | 17 | package-lock.json (124.0KB) | 496 | 3 | 1035 | 93.5% | completed |
| openai-qwen-3.8-high-20260917t233654z | qwen-3.8 | high | 0.0750 | 20.7M/1.6M/1.5M/19.4M | $50.9001 | $16.9448 | 3h 19m 33s | 5 | 255 | 4/13 | 17 | package-lock.json (124.0KB) | 478 | 4 | 993 | 93.6% | completed |
| openai-qwen-3.8-medium-20260917t163837z | qwen-3.8 | medium | 0.1375 | 23.0M/387.2K/295.1K/21.5M | $48.3692 | $10.6072 | 1h 54m 58s | 17 | 924 | 5/13 | 17 | core (487.4KB) | 293 | 7 | 605 | 93.3% | completed |
| openai-qwen-3.8-medium-20260918t025836z | qwen-3.8 | medium | 0.0750 | 9.6M/681.9K/635.7K/9.0M | $23.3165 | $7.6473 | 1h 13m 11s | 6 | 630 | 4/13 | 17 | package-lock.json (124.0KB) | 268 | 7 | 556 | 93.1% | completed |
| openai-qwen-3.8-medium-20260918t075214z | qwen-3.8 | medium | — | —/—/—/— | $66.3730 | — | 4h 8m 40s | — | — | — | 17 | package-lock.json (124.0KB) | 1655 | 3 | — | — | timed_out |
| openai-qwen-3.8-medium-20260918t120617z | qwen-3.8 | medium | — | 14.8M/963.3K/903.0K/12.3M | $35.4271 | $13.8319 | 3h 24m 7s | 7 | 121 | — | 17 | package-lock.json (124.0KB) | 376 | 4 | 801 | 83.2% | failed |
| openai-qwen-3.8-medium-20260918t155851z | qwen-3.8 | medium | — | —/—/—/— | $74.7160 | — | 6h 2m 52s | — | — | — | 17 | core (322.2MB) | 1396 | 4 | — | — | timed_out |
