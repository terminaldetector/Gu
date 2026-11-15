# GU_MINIMAL_CORE_MANIFEST

**Фаза:** Architecture Reset / Phase 0 (read-only)
**База:** `2be2dae`
**Назначение:** минимальная самостоятельная сборка «эмуляторы + AGOD» без Male CNS, FDB, `Graph` и старых контроллеров, плюс проект минимального AGOD API и портов нового агента. Это условие остановки Phase 0: runtime не заменяется, пока API не спроектирован.

---

## 1. Доказательство самостоятельности

Дерево собрано только из KEEP-файлов (`GU_DEBLOAT_DEPENDENCY_AUDIT.md` §6):
- 53 ассета `lab/`, 18 МБ вместе с исходными архивами ядер;
- фикстуры `tools/sega-api6`, `tools/vendor`, `tools/retro`;
- генераторы тестовых ROM.

Без единого Java-класса, без `male-cns.fly.gz`, `learner.js`, `fdb-*`, `layer-*`, `dual-*` и без `lab.js`. В нём запущены AGOD- и эмуляторные гейты CI.

| Гейт | Результат в минимальном дереве |
|---|---|
| `agod_platform_driver_check` | PASS 85/85 |
| `agod_g3_platform_independence_test` | PASS (exit 0) |
| `agod_g4_platform_scenarios` | PASS 68/68, 0 blocked platforms |
| `agod_g5_sequence_check` | PASS 28/28 |
| `agod_d1_frontier_check` | PASS 39/39 |
| `agod_d2_progress_check` | PASS 60/60, 0 blocked platforms |
| `agod_survival_check` / `agod_stage_check` / `agod_explore_check` | PASS 26/26, 8/8, 14/14 |
| `agod_rom_check`, `goal_discovery_check`, `objective_profiles_check`, `core_probe_check`, `nes_write_trace_check` | PASS |
| `nes_check`, `retro_check` (SNES), `sega_check`, `sega_rom_check`, `sega_p2_check`, `sega_six_button_check`, `sega_render_check` | PASS |
| `save_states_check`, `score_search_check`, `human_capture_check`, `benchmark_check` | PASS |
| `emulation_clock_check` | **FAIL (ожидаемо):** проверка читает `lab.js`, который идёт на REWRITE. Тест переносится на `EmulatorHost` |

Итог: **25/26 PASS.** Эмуляторы и AGOD уже работают без нейроконтура. Связь с ним держится только на `lab.js`, `index.html`, `NesLabActivity` и стенде `agod_realrom_check.cjs`.

---

## 2. Манифест файлов минимального ядра

### 2.1 Эмуляторный слой (WebView + Node)

| Файл | Размер | Провенанс |
|---|---|---|
| `lab/platforms.js` | 1 КБ | таблица платформ: кнопки, RAM, порты |
| `lab/jsnes.min.js` + `jsnes-source.json` + `JSNES-LICENSE.txt` | 133 КБ | JSNES |
| `lab/sega-core.js` + `lab/sega/{genplus.js,genplus.wasm,genplus-source.zip,source.json,LICENSE.txt}` | 6,5 МБ | Genesis Plus GX `49c5847`, wasm-genplus `6090aff`, Emscripten 3.1.57 |
| `lab/retro-core.js` + `lab/snes/*` | 7,7 МБ | Snes9x `1bcc369`; **сборка CI** `tools/build_retro.py` (emsdk 3.1.57) |
| `lab/retro-core.js` + `lab/gb/*` | 1,8 МБ | Gambatte `d9d6cd0`; сборка CI |
| `lab/controller.js`, `emulation-clock.js`, `save-states.js`, `settings.js`, `interface-settings.js`, `game-tools.js`, `episode-starts.js` | ~25 КБ | ввод, темп, слоты, старты эпизодов |
| `lab/score-search.js`, `human-capture.js`, `benchmark.js`, `training-sessions.js` | ~23 КБ | диагностика и данные (демонстрации) |
| `lab/demo-{rom,sega,gb,gbc,snes}.json` | — | оригинальные диагностические картриджи (фикстуры) |
| CSS: `console-shell`, `console-ui`, `material-ui`, `play-ui`, `interface-ui` | — | оформление консоли |

Сборка ядер: `tools/build_sega.py`, `tools/build_retro.py`, `tools/retro/bridge.cpp`, `tools/build_nes_trace.py`. Тестовые ROM: `tools/make_*rom*.py`.

**Эталонные ядра** — это артефакт CI `FlyConsole-retro-cores`. Локальная сборка emcc 3.1.6 расходится с CI: `platform_ui` красный, сохранённое состояние GB не восстанавливается (риск R7).

### 2.2 AGOD

| Группа | Файлы | Где исполняется |
|---|---|---|
| Ядро обнаружения целей | `agod-ram`, `agod-causal`, `agod-goals`, `agod-reward`, `agod-evidence`, `agod-replay`, `agod-candidates`, `agod-consumers`, `agod-pipeline`, `agod-positive` | Node, Web Worker |
| Платформенный контракт | `agod-platform-driver`, `agod-nes-driver` | Node, Worker |
| Фаза, выживание, стадия | `agod-phase`, `agod-survival`, `agod-stage` | Node, Worker |
| Поиск / frontier-архив | `agod-sequences`, `agod-graph`, **`agod-explore`** | Node (стенд) |
| DTO / профили / награда | `agod-goal-dto`, `agod-objective` | Node, Worker, страница |
| Воркер приложения | `agod-worker.js` | Web Worker (собственный экземпляр ядра) |
| Базовая линия | `agod-dqn.js` | Node (исследование) |
| Ранние модули S-серии | `goal-discovery.js`, `objective-profiles.js`, `core-probe.js`, `nes-write-trace.js` (+ источники и лицензии) | страница, Node |
| Независимая проверка | `research/mesen-causal/**` | Node + Mesen |
| Гейты | 21 файл `tools/agod_*` из CI, исследовательские `agod_*`, `make_agod_*_rom.py` | Node |

`agod-explore.js`, `agod-stage.js` и `agod-graph.js` **не подключены** ни в `index.html`, ни в воркере, но обязательны: на них стоят frontier-архив и проверка прохождения в исследовательском стенде.

### 2.3 Android (минимум)

| Класс | Роль |
|---|---|
| `EmulatorActivity` (новый, из `NesLabActivity`) | WebView-хост, жизненный цикл, ROM, сохранения, диагностика. Без `Engine`/`Fdb*`/`Dual*` |
| `RomImport`, `RomLibrary` | картриджи |
| `ControllerInput` | физические геймпады |
| `DeviceLog`, `DiagnosticJournal`, `DiagnosticSummary`, `DiagnosticsApplication` | диагностика |
| `EpisodeHistory`, `CurriculumStore`, `TrainingSessionStore`, `CheckpointDigest` | эпизоды, разбиение train/holdout, демонстрации |
| `LabRequestFailure`, `UiInsets` | служебные |
| `ScoreOcr` (опционально, KEEP\*) | ML Kit OCR: +41 МБ нативных библиотек на 4 ABI |

Manifest: одна activity-лаунчер. `INTERNET` остаётся удалённым (`tools:node="remove"`).

### 2.4 Что не входит

Male CNS (граф, профиль маршрутизации, конвертеры), `Engine`/`GpuLifEngine`, все `Fdb*`, `Dual*`, `IsolatedFdbContext`, `MainActivity`, `CodeLabActivity`, `learner.js`, нейропанели UI, `FdbGameBridge.java`. Всё это остаётся в архивной ветке `archive/gu-2be2dae-male-cns-fdb` (M0) и в продукт не возвращается.

### 2.5 Ожидаемый размер

| | Базовый APK | Минимальное ядро |
|---|---|---|
| Male CNS | 91,6 МБ | 0 |
| ML Kit OCR | 41,0 МБ | 0 или ~11 МБ (только arm64-v8a) |
| Эмуляторы | 12,4 МБ | 12,4 МБ |
| dex + прочее | ~6 МБ | ~3 МБ (оценка) |
| **Итого** | **151,1 МБ** | **~15–27 МБ** без модели агента |

Модель агента добавит, по официальным файлам:
- GGUF: Q4_0 219 МБ + mmproj Q8_0 103 МБ;
- ONNX: vision fp16 189 МБ + decoder q4 481 МБ + embed fp16 134 МБ.

Способ доставки без сети решает владелец (риск R11).

---

## 3. Минимальный AGOD API (проект)

Цель: AGOD остаётся **самостоятельным исследовательским модулем**. Агент видит только порты; исследовательские сервисы с правом на savestate физически недоступны frozen-оценке.

### 3.1 Уровень 0: PlatformDriver (существует, контракт замораживается)

`FlyAgodPlatformDriver.create(spec)` → `{status, platform, coreRevision, driverRevision, driver, capabilities, framesRun(), budgetRemaining(), dispose()}`, где
`driver = {run(mask, frames, mask2?), readRam(), readRamSparse?(addrs), snapshot(), restore(state), stateHash(), poke?(addr,v), physicalAddressOf(off, region), ports, actionSpec, observedRamBytes}`
(`agod-platform-driver.js:214–311`).

**Недостаёт одного:** у драйвера нет доступа к кадру. Стенд сейчас обходит контракт через `built.core.pixels` (`agod_realrom_check.cjs`, `Observation.grid(core)`, `Stage.signature(core.pixels, …)`). Добавить:

```text
driver.video() -> { width, height, format: 'RGBX8888', pixels: Uint32Array /* только чтение, копия или вид на последний кадр */ , frame: Number }
```

`capabilities.supports.video = true`. Проверка — эмуляторные гейты плюс новый `video_contract_check` (`GU_MIGRATION_TEST_PLAN.md` §3).

### 3.2 Уровень 1: сервисы AGOD для продукта (без savestate)

| Сервис | Существующая реализация | Вход → выход | Гарантии |
|---|---|---|---|
| `discover(request)` | `agod-worker.js` (`{type:'run', sessionId, platform, romBase64, startSnapshot?, frameBudget, config}` → `started` / `progress` / **один** из `result`, `error`, `cancelled`) + `FlyAgodPipeline.run` + `FlyAgodGoalDto.fromPipelineResult` | ROM → `GoalEvidenceDTO` (VERIFIED / REFUSED с причиной) | свой экземпляр ядра; живая игра не трогается; бюджет кадров |
| `liveReward(profile)` | `FlyAgodObjective.createLiveReward(profile, modules, {identity, sessionId, ledger, policy})` | `observe({ramBefore, ramAfter, endFrame, requestedMask, executed, phase})` → пакет `{status: VERIFIED │ PROVISIONAL │ UNKNOWN │ INVALIDATED, value?, reason}` | **UNKNOWN ≠ 0**: у UNKNOWN/INVALIDATED нет `value`; одна выплата на событие (ledger); профиль привязан к ROM, ядру и ревизии детектора |
| `stageMonitor()` | `FlyAgodStage.createMonitor({probe, readResource})` | поток `{mask, ramBefore, ramAfter, signature, scene}` → `transitions()` | только наблюдение |

Награда уходит агенту через `RewardSink` (§4), а не в `lab.js`. `agod-live.js` переписывается в адаптер «профиль → RewardSink».

### 3.3 Уровень 2: исследовательские сервисы (savestate разрешён, только стенд)

| Сервис | Где сейчас | Проектный интерфейс |
|---|---|---|
| frontier-архив | `agod-explore.js` + `exploreRoute()` в стенде | `explore(driverFactory, profile, opts) → {archive, route, verdict}` |
| recovery teacher | `recoveryTeacher()` в стенде | `teach(driverFactory, policy: PolicyAdapter, perturbations, opts) → TeacherTrajectory{masks, kinds P/C/D, corrections, levelClear}` |
| разметчик пригодности | `suitabilityLabeller()` | `label(trajectory, actions, {H, mode: 'route'│'hold'}) → {suitable[], lifeLost[]}` |
| позиционная диагностика | `positionController()` | `boundRelocation(trajectory, perturbations) → table` (верхняя граница, не агент) |
| вердикт прохождения | `verifyLevelClear()` + stage detector + `oracle.json` | `verifyLevelClear(trace) → VERIFIED │ UNVERIFIED` — **оракул открывается только после прогона** |

`PolicyAdapter` — то, что teacher «ведёт». Через него к стенду подключается любая политика: P0 Male CNS (архив), будущий LFM-агент, случайная.

```text
PolicyAdapter = {
  reset(seed),
  decide(observation: {frame: video(), frameIndex}) -> {mask, id},
  observeExecuted(id, mask),                  // для рекуррентного состояния политики
  snapshot() / restore(state)                 // ТОЛЬКО для teacher (research); во frozen-оценке отсутствует
}
```

### 3.4 Граница frozen-оценки

| Разрешено во frozen eval | Запрещено во frozen eval |
|---|---|
| `driver.run`, `driver.video` в живом эмуляторе | `snapshot`/`restore`, `poke` |
| `AgentRuntime.decide` | любые сервисы уровня 2, `oracle.json` |
| `stageMonitor` и `verifyLevelClear` **после** прогона, по записи | награда в агент, обновление весов, skill memory |

Реализация: frozen-оценка получает драйвер-обёртку без `snapshot`/`restore`/`poke`, со счётчиком попыток (как `vRestores` в стенде, где `restores = 0` проверяется в отчёте). Чекпоинт агента хэшируется до и после прогона.

---

## 4. Порты нового агента (проект, без реализации)

| Порт | Направление | Контракт |
|---|---|---|
| `FrameSource` | эмулятор → агент | **последний кадр побеждает**: слот на 1 кадр + номер кадра; при занятом агенте новый кадр замещает старый, очереди нет. Метки: `frameIndex`, `emuTimeMs`, `wallTimeMs` |
| `ActionSink` | агент → эмулятор | маска для порта 1 (и порта 2); действие привязано к `frameIndex` кадра, по которому принято; запаздывание логируется |
| `RewardSink` | AGOD → агент (только обучение) | пакеты `liveReward` как есть; UNKNOWN передаётся как отсутствие награды |
| `AgentRuntime` | — | `load(checkpoint)`, `reset(seed)`, `decide(frame) → action`, `train(batch)` (вне frozen), `checkpointDigest()` |

### Транспорт кадров (кандидаты; выбор на шаге M3 по замерам)

| Вариант | Проверено | Замечания |
|---|---|---|
| A. Как сейчас: `addJavascriptInterface` + JSON / base64 | существует в коде | кадр 256×224×4 = 229 КБ; base64 даёт +33% и строковые копии; не замерялось |
| B. `WebMessagePort` + `ArrayBuffer` (`androidx.webkit`, `WebMessageCompat.TYPE_ARRAY_BUFFER`) | **API есть** в androidx.webkit 1.19.0-alpha01 (исходники). Перед использованием проверять `WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER`: зависит от версии WebView на устройстве | приложение сейчас не зависит от androidx; потребуется зависимость |
| C. Нативные ядра (те же libretro Snes9x/Gambatte/Genesis Plus GX через NDK; для NES — нативное ядро вместо JSNES) | не проверялось | кадр сразу в нативной памяти рядом с runtime модели, без WebView на горячем пути; это большой REWRITE хоста и замена JSNES |

Рекомендация на M3: сначала замерить B на реальном устройстве (задержка кадр → нативный буфер, p50/p95, при 30 Гц). Переходить к C, только если B не укладывается в бюджет задержки.
