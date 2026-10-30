# Воспроизведение E0

Все команды выполняются из корня репозитория на коммите
`775aa68053c7b99bf699f16c1418b997ce507250` (ветка `feature/agod-instrumented-nes`).

## 0. База

```sh
git fetch origin
git rev-parse feature/agod-instrumented-nes   # ожидается 775aa68053c7b99bf699f16c1418b997ce507250
git status --porcelain | wc -l                # ожидается 0
```

## 1. Зависимости

```sh
pip install -r tools/requirements.txt
```

Без этого `tools/check.sh` падает на первой же строке (`python tools/test_convert.py`)
с `ImportError: pyarrow`.

## 2. Отдельные AGOD-проверки (P0-область)

```sh
node tools/core_probe_check.cjs
node tools/nes_write_trace_check.cjs
node tools/goal_discovery_check.cjs
node tools/objective_profiles_check.cjs
node tools/agod_rom_check.cjs
```

Все пять завершаются кодом 0. Логи: `logs/core_probe_check.log` и далее по именам.

## 2a. Экспериментальные проверки E2 / E3 / E4 / AGOD-08 / E5 / E6 / E7

Добавлены этой ревизией. `tools/check.sh` и CI не изменялись, поэтому запускаются
отдельно, из корня репозитория:

```sh
AGOD_RAM_REPORT=logs/ram_type_report.json      node tools/agod_ram_check.cjs
AGOD_CAUSAL_REPORT=logs/causal_report.json     node tools/agod_causal_check.cjs
AGOD_REWARD_REPORT=logs/reward_report.json     node tools/agod_reward_check.cjs
AGOD_EVIDENCE_REPORT=logs/evidence_report.json node tools/agod_evidence_check.cjs
AGOD_DQN_REPORT=logs/dqn_report.json          node tools/agod_dqn_check.cjs
AGOD_PIPELINE_REPORT=logs/pipeline_report.json node tools/agod_pipeline_check.cjs
AGOD_REPLAY_REPORT=logs/replay_report.json     node tools/agod_replay_check.cjs
AGOD_SACRIFICE_REPORT=logs/sacrifice_report.json node tools/agod_sacrifice_check.cjs
AGOD_POSITIVE_REPORT=logs/positive_report.json node tools/agod_positive_check.cjs
CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium AGOD_BRIDGE_REPORT=logs/bridge_report.json node tools/agod_experimental_bridge_check.cjs
```

Каждая завершается кодом 0 и печатает итоговый JSON последней строкой; переменные
окружения необязательны и только сохраняют машиночитаемый отчёт. Контролируемые
картриджи генерируются самой проверкой через `tools/make_agod_test_rom.py`
(нужен `python3`), во временный каталог, который удаляется после прогона;
коммерческих ROM не требуется и в репозитории их нет.

`agod_ram_check.cjs` дополнительно читает `logs/agod_rom_check.log` из этого же
каталога отчёта: числа базы, с которыми он сравнивается, берутся из закоммиченного
прогона E0, а не из текста отчёта. Прогон занимает несколько минут: 150 событий на
каждую из 8 масок плюс нейтральный контроль той же длины на каждый картридж.

`agod_dqn_check.cjs` — самая долгая проверка (десятки минут): 7 картриджей × 6
сидов агента × (обучение + замороженная оценка + случайная политика), и для
каждого картриджа заново проходится вся внутренняя цепочка (причинность →
типизация → индукция → реестр → брокер).

`agod_pipeline_check.cjs` прогоняет собранный конвейер на 7 картриджах разработки и
на 7 held-out-семенах (200…206, зафиксированы до первого прогона), плюс агент на
held-out. Тоже десятки минут. Список семян менять нельзя: это условие оценки.

## 3. Полная регрессия

```sh
bash tools/check.sh
```

Ожидаемое поведение в окружении без emscripten: 115 PASS, затем выход с кодом 1 на
`tools/fdb_game_check.cjs` (`Cannot find module app/src/main/assets/lab/snes/core.js`).
Лог: `logs/check_sh_run2.log`.

Если Maven Central ответит HTTP 429 на шаге загрузки `json-20240303.jar` — это
транзиентный лимит, повторить запуск. Ожидаемый SHA256 jar:
`3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed`.

## 4. Шаги после блокера (вручную)

Нужен `json.jar` (тот же, что качает `check.sh`) и каталог классов:

```sh
B=/tmp/e0build && mkdir -p "$B/classes"
curl -sS -o "$B/json.jar" https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar

javac -cp "$B/json.jar" -d "$B/classes" \
  app/src/main/java/org/node/flyconsole/{Graph,GraphDelta,Engine,Experiment,GraphCache,CheckpointDigest,TrainingSessionStore,LabModule,InferenceProgram}.java \
  tools/{TrainingSessionStoreCheck,CodeLabCheck,ReleaseCheck}.java

for c in TrainingSessionStoreCheck CodeLabCheck ReleaseCheck; do
  java -cp "$B/classes:$B/json.jar" org.node.flyconsole.$c
done

for c in sega_check sega_rom_check sega_p2_check sega_six_button_check \
         sega_render_check sega_learning_check benchmark_check; do
  CODE_CLASSPATH="$B/classes:$B/json.jar" node tools/$c.cjs
done
```

Все завершаются кодом 0.

## 5. Что воспроизвести нельзя в этом окружении

```sh
node tools/fdb_game_check.cjs        # требует assets/lab/snes/core.js
node tools/expanded_game_check.cjs   # то же
node tools/retro_check.cjs           # то же
python tools/build_retro.py          # требует emscripten (emmake/emcc)
```

Для этих шагов нужен CI-образ с emscripten 3.1.57 либо предсобранные retro-ядра.

## 6. Извлечение метрик из логов

`baseline_metrics.json` собран из JSON-строк в `logs/agod_rom_check.log` и
`logs/nes_write_trace_check.log` (и из `logs/check_sh_run2.log` для второго прогона
трассировки). Генерирующие скрипты не коммитятся: это одноразовые парсеры логов,
все исходные строки сохранены в `logs/`, и любой парсер даст те же числа.
