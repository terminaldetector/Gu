# FDB: аудит достижимости структурного роста (Пакет B, 2026-10-17)

Статус: исследовательская ветка, инструмент диагностики, не изменение боевого ядра.
База: `3462e0532aafeb459ea85c968078407af711f423` (`v2/gmode-fdb-gpu`, HEAD).
Ветка: `research/fdb-growth-audit`.
Инструмент: `tools/FdbGrowthReachabilityAudit.java`. Отчёт: `docs/reports/research-fdb-growth-audit-2026-10-17/reachability-audit.json`.

Этот документ закрывает вопрос, поставленный перед Пакетами A/B: может ли текущий runtime
одновременно активировать `FdbGrowth` и `FdbLearning` на одном `GraphDelta`, и может ли
`FdbLearning` впоследствии изменить или удалить связь, созданную `FdbGrowth`.

**Файлы из защищённого списка (`Engine.java`, `GraphDelta.java`, `FdbLearning.java`,
`FdbGrowth.java`, `NesLabActivity.java`, `DualAgentContext.java` и другие) не изменялись.**
Инструмент — новый файл в `tools/`, вызывающий только их существующие публичные методы.

## Метод

Три независимые проверки, каждая — реальный вызов продакшен-кода, не имитация:

1. **Матрица `NesLabActivity`.** Воспроизводит точную формулу вызова
   `fdbGrowth.observe(result, 0, lesions, frozen||!learningMode.equals("off"))` из
   `NesLabActivity.sample()` (строка процитирована в коде инструмента) для всех
   сочетаний `learningMode ∈ {off, train, teach, eval, benchmark-*}`, флага `frozen`
   запроса и `rewardGate`, и фиксирует, создаёт ли вызов связь.
2. **Достижимость в `DualAgentContext`.** Строит реальный `DualAgentContext` с
   `growth.enabled=true`, `rewardGate=false`, `explore=true` (конфигурация, максимально
   благоприятная для срабатывания роста), прогоняет 60 настоящих вызовов `sample()` с
   максимальным сенсорным драйвом и валидными исходами, затем читает
   `fdbState().growthState.windows` — счётчик, который инкрементирует только
   `FdbGrowth.observe`.
3. **Межмеханизменный тест.** Создаёт связь `0→16` исключительно через
   `FdbGrowth.observe()` (не `addEdge`, не `FdbLearning`), затем прогоняет `FdbLearning`
   через настоящий цикл `decide()/feedback()` на этом же `GraphDelta`: 40 исходов с
   положительным подкреплением, затем до 200 с отрицательным.

## Результаты (реальный прогон, не прогноз)

1. **`NesLabActivity`: рост и обучение взаимоисключающие по конструкции.** Из 20
   проверенных сочетаний связь создаётся ровно в одном: `learningMode=="off"` **и**
   `rewardGate=false`. При любом активном режиме обучения (`train/teach/eval/benchmark-*`)
   вычисленный аргумент `frozen`, передаваемый в `observe`, всегда `true` — рост
   заморожен. Даже при `learningMode=="off"` и `rewardGate=true` (дефолт конфигурации)
   рост не срабатывает, потому что `reward` в этом вызове — жёстко заданный литерал `0`,
   а `rewardGate&&reward<=0` блокирует вызов. Одновременная мутация в этом пути **не
   достижима** ни при каких настройках.
2. **`DualAgentContext`: `FdbGrowth.observe()` не вызывается вовсе.** После 60 реальных
   `sample()` под самой благоприятной для роста конфигурацией `growthState.windows`
   остался `0`. Объект `growth` создаётся и его состояние (де)сериализуется, но
   продвигается он только из `NesLabActivity`-подобного пути, которого в
   `DualAgentContext.sample()` нет. Рост здесь не «подавлен» — он структурно мёртв,
   независимо от конфигурации.
3. **Межмеханизменное изменение подтверждено.** Связь, созданная `FdbGrowth` с весом 8,
   была усилена `FdbLearning` до ≈12.24 за 40 положительных исходов, затем удалена
   `FdbLearning` (`prunedByFdbLearning=true`) после продолжительного отрицательного
   подкрепления. `GraphDelta.Edge` не хранит, какой механизм создал связь, и цикл
   `feedback()` в `FdbLearning` итерирует `layer.edges()` безусловно — поэтому
   происхождение связи не влияет на то, может ли другой механизм её изменить.

## Интерпретация

Это не баг в `FdbGrowth` или `FdbLearning` — это свойство текущего публичного контракта:
**совместное инстанцирование на одном `GraphDelta` доказывает только общее владение
структурой, а не одновременное исполнение правил**, и в обоих известных путях вызова
одновременное исполнение не достижимо. При этом последовательное взаимодействие (один
механизм создаёт, другой впоследствии меняет/удаляет) достижимо всегда, когда оба
когда-либо писали в один `GraphDelta` — технически подтверждено пунктом 3.

Открытый вопрос, который этот аудит не закрывает (вне объёма Пакета B по этому коммиту):
есть ли иные пути конфигурации/вызова (не `NesLabActivity.sample()` и не
`DualAgentContext.sample()`), где рост достижим одновременно с обучением — например,
через прямой вызов Java API в тестах или в коде, добавленном после этого коммита.

## Ограничения

- Проверены только два известных продакшен-пути вызова (`NesLabActivity`,
  `DualAgentContext`). Другие пути (если появятся) требуют отдельной проверки.
- Это Java-fixture на хосте, не Android-устройство и не ROM-геймплей.
- Вывод о том, нужно ли добавлять provenance-поле в `GraphDelta`, не делается здесь —
  это отдельное архитектурное решение, которое аудит только информирует фактами.

## Как воспроизвести

```sh
mkdir -p /tmp/fdb-audit-build && cd /tmp/fdb-audit-build
curl -sS -o json.jar https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar
mkdir -p classes
javac -cp json.jar -d classes \
  app/src/main/java/org/node/flyconsole/Graph.java \
  app/src/main/java/org/node/flyconsole/GraphDelta.java \
  app/src/main/java/org/node/flyconsole/FdbGrowth.java \
  app/src/main/java/org/node/flyconsole/FdbLearning.java \
  app/src/main/java/org/node/flyconsole/Engine.java \
  app/src/main/java/org/node/flyconsole/Experiment.java \
  app/src/main/java/org/node/flyconsole/FdbCheckpoint.java \
  app/src/main/java/org/node/flyconsole/DualAgentContext.java \
  app/src/main/java/org/node/flyconsole/DualLayerStore.java \
  app/src/main/java/org/node/flyconsole/DualRequestGuard.java \
  app/src/main/java/org/node/flyconsole/LayerSetStore.java \
  app/src/main/java/org/node/flyconsole/FdbDiagnostics.java \
  app/src/main/java/org/node/flyconsole/GpuLayerSync.java \
  tools/FdbGrowthReachabilityAudit.java
java -cp "classes:json.jar" org.node.flyconsole.FdbGrowthReachabilityAudit /tmp/fdb-growth-reachability-audit.json
```

`tools/check.sh` и CI основного проекта не изменялись, как было указано в объёме Пакета B.
