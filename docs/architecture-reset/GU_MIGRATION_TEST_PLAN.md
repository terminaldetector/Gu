# GU_MIGRATION_TEST_PLAN

**Фаза:** Architecture Reset / Phase 0 (read-only)
**База:** `2be2dae` (`research/agod-neural-e0-e1`)
**Связанные документы:**
- `GU_DEBLOAT_DEPENDENCY_AUDIT.md`: классификация, риски R1–R11, шаги M0–M5;
- `GU_MINIMAL_CORE_MANIFEST.md`: минимальное ядро, AGOD API, порты агента;
- `LFM_STREAMING_WEIGHT_MODIFICATION_OPTIONS.md`: варианты модели.

---

## 1. Базовые результаты (зафиксированы до изменений)

### 1.1 CI на базовом коммите

GitHub Actions `Android APK`, прогон **43703791646**, `head_sha 2be2daed…`: **success**, 13 мин 09 с.

| Шаг | Длительность | Итог |
|---|---|---|
| `build_sega.py` / `build_retro.py` (emsdk 3.1.57) | 11 с / 84 с | success |
| `tools/check.sh` | 5 мин 08 с | success |
| UI-наборы `run_ui_checks.cjs` (24) | 3 мин 11 с | success (24/24) |
| `gpu_runtime_check.py`, `bundle_data.py`, Male CNS CPU, `check_full_dual.sh` | 1 с / 29 с / 4 с / 23 с | success |
| `gradle assembleDebug lintDebug assembleRelease lintRelease` | 52 с | success |

### 1.2 Локальный прогон

Экспорт `git archive 2be2dae` вне рабочего дерева. Ядра GB/SNES собраны локально emcc 3.1.6.

| Набор | Итог | Детали |
|---|---|---|
| `tools/check.sh` | **exit 0**, 7 мин 18 с | 154 команды; 158 строк PASS; **1 BLOCKED по дизайну**: `agod_realrom_check` без `AGOD_PRIVATE_ROMS` ничего не засчитывает и не подставляет фикстуру |
| Ключевые счётчики AGOD | | platform-driver 85/85 · G4 68/68 · D2 60/60 · D1 39/39 · G5 28/28 · survival 26/26 · explore 14/14 · stage 8/8 |
| UI-наборы | **23/24** | `platform_ui` красный **детерминированно**, 3 из 3 прогонов: после `loadState` на GB `frame` 17 вместо 5, RAM не совпадает. В CI тот же коммит зелёный. Причина в окружении: локальные ядра GB/SNES собраны emcc 3.1.6, в CI — emsdk 3.1.57 (риск R7). **Эталон UI — CI** |
| `gradle assembleDebug` | success, 53 с | `app-debug.apk` 151 089 763 байт, SHA-256 `ca55e34c7bc95bd8e8d99ad92221d2a1e580d1be074c8d28aa8cc96649a874ef` |
| Минимальное дерево (только KEEP, без Java и Male CNS) | **25/26** | единственный FAIL — `emulation_clock_check`: читает `lab.js` (REWRITE) |

### 1.3 Исследовательская базовая линия (приватный корпус, не гейт CI)

Это итоги Issue #8 / M4 для Contra III. Перезапускаются только на приватном корпусе и в репозиторий не публикуются, кроме агрегатов.
- P0 на delay 0 даёт `LEVEL_CLEAR=VERIFIED`, но только на engine seed 11 (шум LIF как часы).
- На delays 1/2/4/8 и при вмешательствах P0 приходит к game over.
- Слепое воспроизведение маршрута: VERIFIED на d0, game over на d1–d8.
- Teacher-траектории `t-d5` и `t-x2100` — VERIFIED на свежей загрузке.

Этими цифрами новый агент будет сравниваться в M5, вместе с «оригинальным readout» и «open-loop replay».

---

## 2. Критерии сохранения возможностей

Каждая возможность закреплена тестом, который должен оставаться зелёным на указанных шагах. Отмена шага — если тест покраснел.

| # | Возможность | Тест(ы) сейчас | Зелёный на шагах |
|---|---|---|---|
| C1 | 4 платформы: загрузка, кадр, звук, порты, RAM, сохранение/восстановление, сброс | `nes_check`, `sega_check`, `sega_rom_check`, `sega_render_check`, `sega_p2_check`, `sega_six_button_check`, `retro_check` | M0–M5 |
| C2 | ROM: импорт, библиотека, целостность | `RomImportCheck`, `RomLibraryCheck` | M0–M5 |
| C3 | Слоты сохранений, старты эпизодов | `save_states_check`, `save_states_ui_check`, `episode_starts_ui` | M0–M5 |
| C4 | Ввод: экранный и физический геймпад, клавиатура, 2P | `ControllerInputCheck`, `controller_check`*, `two_player_mode_check`*, `settings_check`, `interface_settings_check` | M0–M5 (*переписываются в M2 без `learner.js`) |
| C5 | Интерфейс: ориентации, раскладки, навигация, пауза, выход | `platform_ui`, `interface_ui`, `portrait_rotation_ui`, `landscape_ui`*, `console_layout`*, `console_navigation_ui`*, `release_regression_ui`* | M0–M5 (*переписываются в M2/M4) |
| C6 | Темп эмуляции и изоляция отказов агента | `emulation_clock_check`*, `neural_isolation_check`* → `agent_failure_isolation_check` | M2–M5 |
| C7 | AGOD: платформенный контракт и независимость | `agod_platform_driver_check`, `agod_g3_platform_independence_test` | M0–M5 |
| C8 | AGOD: сценарии на 4 ядрах, последовательности, frontier, прогресс | `agod_g4_platform_scenarios`, `agod_g5_sequence_check`, `agod_d1_frontier_check`, `agod_d2_progress_check` | M0–M5 |
| C9 | AGOD: выживание, фаза, стадия, frontier-архив | `agod_survival_check`, `agod_stage_check`, `agod_explore_check` | M0–M5 |
| C10 | AGOD в приложении: воркер на 4 ядрах | `agod_worker_platforms` (UI) | M0–M5 |
| C11 | AGOD S-серия: обнаружение, профили, зонды, трасса записи NES | `agod_rom_check`, `goal_discovery_check`, `objective_profiles_check`, `objective_profiles_ui`, `core_probe_check`, `nes_write_trace_check` | M0–M5 |
| C12 | Награда AGOD: VERIFIED/PROVISIONAL/UNKNOWN, **UNKNOWN ≠ 0**, одна выплата на событие | сейчас через FDB: `agod_l1_bridge_check`*, `FdbUnknownRewardCheck` | M1 → переписать на `RewardSink`; не терять между M1 и M4 |
| C13 | Исследовательский стенд: teacher, labeller, стадия, оракул только после прогона | `agod_realrom_check` (приватный корпус) | M1 и далее; на корпусе — до и после разделения |
| C14 | Данные обучения: демонстрации, сессии, эпизоды, учебные группы | `human_capture_check`, `training_sessions_check`, `TrainingSessionStoreCheck`, `EpisodeHistoryCheck`, `CurriculumCheck` | M0–M5 |
| C15 | Методология оценки: frozen-серии, preregistration, продвижение Best | `FrozenSeriesCheck`*, `PairedEvaluationCheck`*, `LearnedRolesCheck`*, `BestPromotionGateCheck` | переписываются в M4 под идентичность чекпоинта LFM |
| C16 | Диагностика устройства | `DiagnosticJournalCheck`, `inspect_diagnostics_check.py`, `session_logger_ui`* | M0–M5 |
| C17 | Offline и приватность: `INTERNET` удалён; ROM и приватные бинарники не коммитятся | Manifest; `check_no_private_binaries.sh` (+ `_test.sh`) | M0–M5, добавить как явный гейт CI |
| C18 | Сборка APK + lint | `gradle assembleDebug lintDebug assembleRelease lintRelease` | M0–M5 |

---

## 3. Новые тесты по шагам миграции

| Шаг | Тест (новый) | Что доказывает | Порог |
|---|---|---|---|
| M0 | `baseline_manifest.json` (артефакт) | зафиксированы SHA, результаты CI и UI, состав APK | файл в архивном теге |
| M1 | `agod_api_contract_check` | `PlatformDriver` (включая новый `video()`) одинаков на 4 ядрах; `capabilities` сериализуются | 4/4 платформы |
| M1 | `video_contract_check` | `video()` отдаёт кадр нужного размера; кадр совпадает с тем, что видит UI; детерминизм на replay | бит в бит на replay |
| M1 | `agod_research_split_check` | teacher, labeller и `verifyLevelClear` работают с `PolicyAdapter` «пустая политика» и с архивным адаптером P0; результаты совпадают с базовой линией | на приватном корпусе: те же агрегаты, что в §1.3 |
| M1 | `reward_port_check` (из `agod_l1_bridge_check` и `FdbUnknownRewardCheck`) | `liveReward` → `RewardSink`: UNKNOWN не даёт числа; одна выплата на событие; при смене ROM профиль сбрасывается | 100 % утверждений |
| M2 | `emulator_host_check` | `EmulatorHost` без нейрокода: цикл, ввод, сохранения, звук, темп | C1, C3–C6 зелёные |
| M2 | `agent_failure_isolation_check` (из `neural_isolation_check`) | падение, таймаут или зависание агента не останавливают эмулятор; ручная игра продолжается | как в исходном тесте |
| M2 | grep-гейт моста | ни один `nativeCall('…')`, `FlyBridge.*` и `window.lab*` не ссылается на отсутствующий метод | 0 висячих ссылок |
| M3 | `frame_port_latency_check` | задержка кадр → нативный буфер и кадр → применённое действие, p50/p95 | пороги задаёт владелец; на устройстве |
| M3 | `no_stale_frame_check` | медленный агент: в очереди ≤ 1 кадра, решение всегда по самому свежему кадру, пропуски считаются и логируются | очередь ≤ 1; возраст кадра решения ≤ 1 период агента |
| M3 | `action_binding_check` | каждое действие привязано к `frameIndex` кадра, по которому принято; запаздывание измеряется | 100 % действий с привязкой |
| M4 | `no_neural_backend_check` | в APK нет `male-cns*`; нет классов `Engine`, `Graph`, `Fdb*`, `Dual*`; в `FlyBridge` нет нейро-методов | 0 совпадений |
| M4 | `apk_size_gate` | APK без модели агента: ≤ 30 МБ (оценка 15–27 МБ; OCR — решение владельца) | порог согласовать |
| M4 | Manifest-гейт | `INTERNET` отсутствует; одна activity-лаунчер | точное совпадение |
| M5 | `frozen_eval_guard_check` | во frozen-оценке драйвер без `snapshot`/`restore`/`poke`; счётчик восстановлений 0; оракул не открывается до конца прогона; нет teacher/AGOD-контроллера; дайджест чекпоинта до и после одинаков; skill memory отсутствует | все условия |
| M5 | `agent_memory_budget_check` | пиковый RSS агентного контура на устройстве | ≤ 2–3 ГБ (цель директивы) |
| M5 | `decision_rate_check` | устойчивая частота решений при живом эмуляторе | 20–30 решений/с (цель директивы) |
| M5 | `visual_observability_check` (V1) | видимые сущности (игрок, враги, снаряды, ресурс, фаза) декодируются из признаков на отложенных траекториях | лучше пиксельных baseline 4×4 / 16×12 / 64×48 |
| M5 | `dynamics_check` (V2) | предсказание признаков и сущностей на +1…+k кадров, движение, скролл | лучше компенсированного движения и константы |
| M5 | `action_consequence_check` (V3) | исход **каждого** действия из точного состояния (hold / закрытые продолжения; savestate только в исследовательском эмуляторе) | лучше константы и пиксельных контроллеров; UNKNOWN не даёт 0 |
| M5 | `control_suitability_check` (V4) | компактный контроллер на признаках, закрытый контур на сегментах | лучше константной политики, простых визуальных контроллеров и AGOD baseline |
| M5 | `autonomous_frozen_policy_check` (V5, итоговый) | целые эпизоды без savestate, оракула, учителя, AGOD-контроллера и обучения; delays 0/1/2/4/8 и вмешательства, отличные от обучающих; несколько seed | сравнение с константой, визуальными контроллерами, open-loop replay и teacher; `LEVEL_CLEAR` по оракулу только после прогона |
| M5 | Правило | предсказание существующих suitability labels **не является** доказательством качества признаков (директива M0, п. 3) | — |
| M5 | Сравнение (директива M4-03) | новый агент против оригинального readout (архив) и open-loop replay; delays 0/1/2/4/8 + вмешательства; обучающие и проверочные возмущения различны | отчёт; Gate B/C по Issue #8 |

---

## 4. Матрица существующих тестов по шагам

### 4.1 `tools/check.sh` (124 отображённые проверки + `node --check`)

| Класс | Кол-во | Шаг |
|---|---|---|
| **KEEP** — зелёные на всех шагах | 48 | эмуляторы (7), AGOD (10 гейтов CI), S-серия (4: `goal_discovery`, `objective_profiles`, `core_probe`, `nes_write_trace`), хранилища (`RomImport`, `RomLibrary`, `EpisodeHistory`, `Curriculum`, `TrainingSessionStore`, `DiagnosticJournal`, `ControllerInput`, `LabRequestFailure`), `save_states*`, `score_search`, `settings`, `interface_settings`, `human_capture`, `training_sessions`, `benchmark`, `build_nes_trace --check`, `inspect_diagnostics_check`, `emulation_clock_check`\*, `BestPromotionGateCheck` |
| **REWRITE** — переписываются, не удаляются | 19 | M1: `agod_l1_bridge_check`, `agod_realrom_check`, `realrom_observation_check`. M2: `controller_check`, `game_tools_check`, `two_player_mode_check`, `system_controls_check`, `console_reset_check`, `runtime_flow_check`, `gmode_check`, `action_hold_check`, `neural_isolation_check`, `emulation_clock_check`\*. M4: `FrozenSeriesCheck`, `PairedEvaluationCheck`, `LearnedRolesCheck`, `LayerSetStoreCheck` |
| **DELETE** — удаляются вместе с кодом в M4 | 57 | Java-проверки LIF/Graph/FDB/Dual/GPU/Synthetic/CodeLab/Release, JS-проверки FDB/dual/layers/shared experience/learner, `test_convert.py`, `gpu_shader_check.py` |

\* `emulation_clock_check` сейчас читает `lab.js`, поэтому до M2 он KEEP, а в M2 переносится на `EmulatorHost`.

Шаги CI вне `check.sh`, удаляемые в M4: `male_cns_converter_check.py`, EGL/GLES для GPU, `gpu_runtime_check.py`, `bundle_data.py`, «Check full Male CNS model», `check_full_dual.sh`.

### 4.2 UI-наборы (24)

| Класс | Наборы |
|---|---|
| KEEP (6) | `agod_worker_platforms`, `interface_ui`, `platform_ui`, `episode_starts_ui`, `portrait_rotation_ui`, `objective_profiles_ui` |
| REWRITE (15) | `console_layout`, `landscape_ui`, `training_ui`, `polish_ui`, `training_flow_ui`, `release_regression_ui`, `autonomous_console_ui`, `continuation_ui`, `autonomous_episodes_ui`, `session_logger_ui`, `console_navigation_ui`, `agent_quick_panel_ui`, `agent_teaching_panel_ui`, `action_hold_ui`, `goal_discovery_ui` |
| DELETE (3) | `layer_ui`, `dual_layout`, `plasticity_speed_ui` |

---

## 5. Гейты выхода из фаз и откат

| Шаг | Гейт выхода | Откат |
|---|---|---|
| M0 | архивная ветка `archive/gu-2be2dae-male-cns-fdb` запушена; `baseline_manifest.json` создан | — |
| M1 | C7–C13 зелёные; `agod_research_split_check` воспроизводит агрегаты §1.3 на приватном корпусе | revert коммитов M1; архивный тег не трогается |
| M2 | C1–C6, C14, C16 зелёные; `agent_failure_isolation_check` зелёный; grep-гейт пуст | revert M2 |
| M3 | пороги задержки и «нет устаревших кадров» выполнены **на устройстве** | оставить транспорт A (как сейчас) и не идти в M5 |
| M4 | весь CI зелёный без графа; `no_neural_backend_check`; Manifest-гейт; размер APK | revert M4 (удаление обратимо по архивной ветке M0 `archive/gu-2be2dae-male-cns-fdb`) |
| M5 | `frozen_eval_guard_check`; бюджеты RAM и частоты; V1–V5 (`LFM_STREAMING_WEIGHT_MODIFICATION_OPTIONS.md` §9); сравнение M4-03 | агент выключается флагом; консоль и AGOD работают (C1–C13) |

Общие правила:
- Ни один шаг не объявляется завершённым по синтетическим проверкам.
- Результаты на реальном картридже — только агрегаты; ROM, кадры, RAM-адреса и трассы в репозиторий не попадают.
- Слияние в `main` и изменения подписи релиза — только с явного разрешения владельца.

---

## 6. Окружение и воспроизводимость

| Требование | Почему |
|---|---|
| Ядра GB/SNES — из артефакта CI `FlyConsole-retro-cores` (emsdk 3.1.57) | локальная сборка emcc 3.1.6 даёт красный `platform_ui` (R7) |
| Тесты запускать на экспортированной копии или в CI | `check.sh` перезаписывает отслеживаемые `fdb-comparison.json` и `expanded-comparison.json` |
| `GU_JSON_JAR` — локальная копия `json-20240303.jar` с проверкой SHA-256 | offline-прогоны |
| Приватный корпус (`AGOD_PRIVATE_ROMS`) — только локально | гейт C13 и сравнение M5 |
| Android-устройство целевого класса | M3/M5: задержка, RAM, частота решений; в облачной сессии устройства нет |

---

## 7. Ход выполнения

Ветка `arch/gu-minimal-core`; архив всего удалённого — `archive/gu-2be2dae-male-cns-fdb`.

| Шаг | Что сделано | Чем закреплено |
|---|---|---|
| M0 | архивная ветка, документы аудита в репозитории | — |
| C1 (M1) | исследовательский стенд AGOD отделён от FDB: `tools/agod_research.cjs` (teacher, labeller, frontier-архив, стадия, frozen-оценка) с адаптером политики `null / route / replay / random` | `agod_research_check` (синтетическая игра, CI); на приватном корпусе агрегаты §1.3 совпали до и после разделения |
| C2a | со страницы удалены dual-агент, Layer Sets, shared experience, archive replay, synthetic import, модельный UI, FDB-диагностика | `node --check`, UI-наборы консоли |
| C2b | со страницы удалены learner (SARSA), FDB feedback, training flow/journal, autonomous episodes, curriculum/episode-history UI, agent quick panel, action hold; `lab.js` — хост эмулятора без агентных хуков; AGOD перенесён на страницу «Исследование» | см. ниже |

Замены тестов на шаге C2b:

| Было | Стало | Почему |
|---|---|---|
| `neural_isolation_check`, `console_reset_check` | `emulator_independence_check` | гейт C6/R4/R6: реальный `lab.js` и NES без агента, детерминизм; отказ хуков AGOD изолирован, отказ ядра останавливает и сообщается; страница вызывает только объявленные методы хоста и не определяет агентных хуков. Проверен мутацией |
| `two_player_mode_check` | `host_invariants_check` | неагентная часть (пропорции кадра, поворот без пересоздания Activity, MIME CSS) сохранена; добавлен запрет `INTERNET`. Человеческий 2P на странице существовал только в паре с агентом |
| `gmode_check`, `system_controls_check`, `current_gate_check`, `runtime_flow_check`, `action_hold_check`, `learning_check`, `demonstration_check`, `fdb_feedback_check`, `fdb_reward_check`, `sega_learning_check` | удалены | проверяли только агент/FDB |
| UI: `training_ui`, `training_flow_ui`, `autonomous_console_ui`, `autonomous_episodes_ui`, `agent_quick_panel_ui`, `agent_teaching_panel_ui`, `plasticity_speed_ui`, `action_hold_ui` | удалены | только агентные экраны |
| `emulation_clock`, `controller`, `game_tools`, `save_states_ui` и 12 UI-наборов | переписаны без learner | инварианты эмулятора, ввода, сохранений и AGOD сохранены |

Критерий C12 перенесён до удаления FDB (узел G1 графа задач 2026-11-16): порт награды `app/src/main/assets/lab/agod-reward-sink.js` (`FlyAgodRewardSink.createRewardSink`) и проверка `tools/reward_port_check.cjs` (в `check.sh`).

| Правило порта | Чем проверено |
|---|---|
| UNKNOWN/INVALIDATED без поля `value`, маршрут `boundary`; VERIFIED/PROVISIONAL без конечного значения отклоняется, а не читается как 0 | синтетика + реальная цепочка; мутация «пропущенное значение = 0» ловится |
| PROVISIONAL — отдельный канал, `confirmed` только у VERIFIED, суммы раздельны | синтетика + реальный агрессивный тир |
| одна выплата на событие в контексте ROM/платформа/ядро/цель — через границы, restore, смену ROM туда и обратно, импорт журнала | синтетика + реальная цепочка; мутация «без журнала» ловится |
| каждая граница (restore, reset, смена ROM) открывает новую эпоху; расчёт до неё — `stale-epoch`; чужой ROM/ядро/цель — `context`; решения строго по возрастанию | синтетика + реальный savestate restore; мутация «без эпохи» ловится |
| награда принадлежит исполненному действию: незавершённое, перехваченное человеком или чужая маска не оплачиваются | синтетика + реальная цепочка (override, mask mismatch) |
| frozen: принятый результат никогда не `learnable` | синтетика |
| инвариант `FdbUnknownRewardCheck`: UNKNOWN через порт не трогает обучаемого и сбрасывает временной кредит; тот же интервал как числовой 0 сдвинул бы baseline | эталонный потребитель в проверке |
| объектные инварианты `agod_l1_bridge_check`: привязка профиля, отказ другому картриджу и раскладке, strict по умолчанию, журнал через перезапуск, override, mask mismatch, revoke | реальная цепочка без FDB |

Не перенесено, так как требует обучаемого контроллера (узлы G6/G8/G11): «веса реально изменились от VERIFIED», «frozen-оценка ничего не меняет», «обученный лучше необученного и случайного». Порт этого не доказывает и не заявляет; эти свойства — контракт будущего контроллера. Порт пока не подключён к странице: его потребитель появится в G6.
