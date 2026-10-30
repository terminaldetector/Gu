# STATUS — GU AGOD / Neural Agent revision

Обновляется при каждом закрытом этапе. Ничего не отмечается закрытым без измерения.

- База ТЗ: `feature/agod-instrumented-nes` @ `775aa68053c7b99bf699f16c1418b997ce507250` (проверено)
- Рабочая ветка: `research/agod-neural-e0-e1`
- Production не изменялся. Merge не выполнялся. `main`, release и `research/fdb-growth-audit` не тронуты.

## Этапы E0–E8

| Этап | Статус | Комментарий |
|---|---|---|
| E0 — Baseline и воспроизводимость | **PARTIAL PASS** | 105/108 шагов регрессии PASS, 3 BLOCKED (нет emscripten). База ТЗ подтверждена. См. `01_GU_BASELINE_AUDIT_RU.md` |
| E1 — Source-level audit | **IN PROGRESS** | Внешние SHA подлежат фактической проверке перед любым переносом |
| E2 — RAM / HUD discovery | NOT STARTED | |
| E3 — Causal validation | NOT STARTED | |
| E4 — Goal induction и reward | NOT STARTED | |
| E5 — Neural RL baseline | NOT STARTED | |
| E6 — Интеграция AGOD и RL | NOT STARTED | |
| E7 — Independent evaluation | NOT STARTED | |
| E8 — Android и продуктовая пригодность | NOT STARTED | блокирован отсутствием устройства |

## Гейты G0–G7

| Гейт | Статус | Чего не хватает |
|---|---|---|
| G0 — Source | **OPEN** | E1 не завершён: SHA, лицензии и решения по переносу не зафиксированы |
| G1 — Observation | PARTIAL | Паритет и bounded trace на хосте PASS; Android не проверен |
| G2 — Causality | **OPEN** | Причинного механизма в базе нет: independent confirmations = 0 |
| G3 — Reward | **OPEN** | Подтверждённой награды нет: verifiedRewards = 0, rewardStatus = UNKNOWN. Контракт UNKNOWN при этом соблюдается |
| G4 — Neural | **OPEN** | Нейросетевого обучения в базе нет |
| G5 — Behavior | **OPEN** | Нет ни blind-корпуса, ни oracle, ни frozen-сравнения |
| G6 — Android | **OPEN** | Нет устройства. Измеренный на хосте probe/core 7.0–10.4% уже напряжён относительно порога ≤10% |
| G7 — Release | **OPEN** | Преждевременно |

## Ключевые факты, установленные измерением (не из документов)

1. База ТЗ подтверждена посимвольно; worktree чист.
2. Всё, что запускается в этом окружении, проходит: 115 PASS-утверждений в `check.sh` + 10 шагов после блокера + 5 AGOD-проверок.
3. Ровно 3 шага недоступны, все по одной причине — отсутствие emscripten для SNES/GB-ядер.
4. ТЗ §2.1 воспроизведён точно (7/7 структурных, 1/7 точный типизированный счётчик).
5. ТЗ §2.2 воспроизведён по паритету (32 / 25 / 117), **но не по overhead** — разброс между прогонами 1.285×–1.526×.
6. Разрыв §2.4 подтверждён данными: 0 verified rewards, 0 independent confirmations, polarity unknown на всех 7 ROM.

## Запрещено заявлять на текущем этапе

- Любое улучшение агента, AGOD или FDB.
- Любую готовность к Android или production.
- Любое обобщение с 7 синтетических контролируемых ROM на реальные игры.
