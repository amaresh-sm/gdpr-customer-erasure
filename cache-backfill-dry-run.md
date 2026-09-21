# Cache-token backfill report

Applied locally only; no commit, cost recalculation, regeneration, or re-verification was performed.

Policy: global median cache ratio from 59 observed non-zero-cache runs was `0.955376637`, clamped to `r = 0.95`.

Updated runs: **18**. Every value uses `floor(input_tokens × 0.95)` and is written to both telemetry cache fields and the existing metadata cached-input field.

| Task | Run | Model | Input | Ratio | Cached |
|---|---|---|---:|---:|---:|
| PayFlow GDPR | openai-claude-opus-5-high-20260915t131229z | Claude Opus 5 | 18,112,831 | 0.950000 | 17,207,189 |
| PayFlow GDPR | openai-claude-opus-5-high-20260915t150106z | Claude Opus 5 | 1,253,391 | 0.950000 | 1,190,721 |
| PayFlow GDPR | openai-claude-opus-5-high-20260917t193741z | Claude Opus 5 | 40,410,706 | 0.950000 | 38,390,170 |
| PayFlow GDPR | openai-claude-opus-5-medium-20260915t054120z | Claude Opus 5 | 25,565,256 | 0.950000 | 24,286,993 |
| PayFlow GDPR | openai-claude-opus-5-medium-20260915t074453z | Claude Opus 5 | 18,950,342 | 0.950000 | 18,002,824 |
| PayFlow GDPR | openai-claude-opus-5-medium-20260915t110250z | Claude Opus 5 | 16,345,318 | 0.950000 | 15,528,052 |
| PayFlow GDPR | openai-claude-sonnet-5-high-20260915t131223z | Claude Sonnet 5 | 25,778,660 | 0.950000 | 24,489,727 |
| PayFlow GDPR | openai-claude-sonnet-5-high-20260915t150107z | Claude Sonnet 5 | 59,249,630 | 0.950000 | 56,287,148 |
| PayFlow GDPR | openai-claude-sonnet-5-high-20260915t165237z | Claude Sonnet 5 | 36,045,802 | 0.950000 | 34,243,511 |
| PayFlow GDPR | openai-claude-sonnet-5-medium-20260915t054120z | Claude Sonnet 5 | 29,590,630 | 0.950000 | 28,111,098 |
| PayFlow GDPR | openai-claude-sonnet-5-medium-20260915t074451z | Claude Sonnet 5 | 24,493,562 | 0.950000 | 23,268,883 |
| PayFlow GDPR | openai-claude-sonnet-5-medium-20260915t095001z | Claude Sonnet 5 | 15,760,047 | 0.950000 | 14,972,044 |
| PayFlow GDPR | openai-grok-4.6-high-20260915t043516z | Grok 4.6 | 6,956,101 | 0.950000 | 6,608,295 |
| PayFlow GDPR | openai-grok-4.6-high-20260915t074451z | Grok 4.6 | 4,894,208 | 0.950000 | 4,649,497 |
| PayFlow GDPR | openai-grok-4.6-high-20260915t095000z | Grok 4.6 | 3,856,529 | 0.950000 | 3,663,702 |
| PayFlow GDPR | openai-grok-4.6-medium-20260915t091803z | Grok 4.6 | 5,482,488 | 0.950000 | 5,208,363 |
| PayFlow GDPR | openai-grok-4.6-medium-20260915t110255z | Grok 4.6 | 3,858,025 | 0.950000 | 3,665,123 |
| PayFlow GDPR | openai-grok-4.6-medium-20260915t121359z | Grok 4.6 | 4,669,410 | 0.950000 | 4,435,939 |

Costs remain unchanged and will be recalculated separately from the updated cache fields.
