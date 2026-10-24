# AGOD PR2 — 2.1.7

База: `134ed71c96e09bdcc09734903fccdd252b8dc856`. Ветка:
`feature/agod-instrumented-nes`. Head указан в ссылке на коммит публикации.
ТЗ и ограничения: [AGOD v1.2](../../GU_AUTOMATIC_GAME_OBJECTIVE_DISCOVERY_TZ_v1_2.md),
[архитектура PR2](../../AGOD_INSTRUMENTED_NES_RU.md).

## Что проверяется

Из закреплённых исходников JSNES 2.1.0 воспроизводимо строится отдельный
readable helper. SHA256 исходного npm-архива, CPU, лицензии, builder и bundle
сохранены в `nes-write-trace-source.json`. Обычный `jsnes.min.js` не изменён.
`GU_SOURCE_ID` теперь учитывает также именованные `*source.json` manifests.

Один экземпляр CPU временно получает инструментированные методы. Трассируются
реальные операции записи JSNES в каноническую RAM, включая зеркала и stack.
Writer PC/opcode принадлежат исполняемой инструкции. Внешние записи и NMI stack
без доказанного writer site остаются UNKNOWN. NROM-128/256 имеет проверяемое
статическое соответствие PRG bank/offset; другие mapper не получают ложного
сопоставления. Поле cycle остаётся UNKNOWN: абсолютная аппаратная метка не
нормализована и не проверена. Внутренние счётчики CPU не объявляются ею.

Никаких новых reward/FDB вызовов, изменений политики или Best promotion нет.
Trace-provenance сама по себе не устанавливает смысл и полярность игровой цели.

## Функциональный gate

[Сырой целевой результат](trace-target.json) использует настоящий vendor CPU и
новый собственный MIT NROM-256. Checker-only assembler oracle не поступает
production helper или adapter. Получено:

- 32 записи в точном порядке с проверенными old/new значениями и 25 writer sites;
  шесть различных инструкций пишут в один канонический байт, представлены два PRG-банка.
- RAM-зеркала, zero-page/absolute/indexed/indirect, STX/STY, stack/JSR и RMW проверены
  по известным инструкциям, включая реализованные JSNES dummy writes.
- 58 инструкций, 53 кадра и 117 границ с совпадением полного `core.toJSON()`
  и аудио/видео hashes: disabled/active/detached, external write, NMI, save/load, reset.
- Настоящий mapper 2 исполняется, но bank provenance получает UNKNOWN; NMI и
  out-of-band CPU.write не наследуют PC предыдущей инструкции.
- Лимиты очереди/кадров/TTL, watchpoints, generation/core replacement, snapshot
  boundary, обработка ошибок sink и точное восстановление методов проверены.

[Исходный FAIL](initial-save-boundary-fail.json) зафиксировал незакрытое окно
при snapshot. Исправление отменяет и очищает trace перед snapshot; реальный
`labGameStates.save/load` дополнительно завершает окно до сериализации/ожидания.
Ассерты не ослаблялись. Отдельно сохранён [предыдущий порядок восстановления](before-restore-order.json).

## Стоимость: ограничение остаётся

Целевой host Node прогон: 12 пар AB/BA на режим, 8 измеряемых кадров на прогон,
12 исключённых warmup-кадров на каждом новом core, одинаковые сериализованные
старты и совпадающие конечные состояния. Raw frame times сохранены.
Это короткий workload общей VM, не Android/WebView и не статистически
подтверждённая оценка батареи или гарантированного overhead.

| Режим | Медиана парного отношения времени condition / baseline | Condition p50 / p95 / p99, мс |
|---|---:|---|
| disabled | 0.998× | 3.286 / 3.641 / 11.405 |
| detached | 1.220× | 4.086 / 4.645 / 13.909 |
| active | 1.359× | 4.504 / 5.042 / 7.213 |

Повтор в полном `tools/check.sh`: медианы disabled **1,005×**, detached
**1,201×**, active **1,386×**. Сырые данные этого отдельного запуска:
[fullcheck-trace.json](fullcheck-trace.json); повтор RAM gate:
[fullcheck-ram.json](fullcheck-ram.json). Два запуска не объединены в
статистическое доказательство; остаточная стоимость видна в обоих.

Даже после точного восстановления методов и удаления временных свойств в
обратном порядке **остаточное замедление detached в этом прогоне сохранилось**.
Совпадение ссылок на функции не доказывает восстановление JIT-стоимости.
Нулевой overhead и преимущество оптимизации не заявляются; нужен отдельный
устойчивый performance-протокол и Android S3. Это известное ограничение до
включения в основной режим, а не закрытый пункт производительности.

## Продуктовое окно и регрессия

Глобальный experimental gate остаётся default OFF. После выбора RAM-кандидатов
допускается один диагностический pilot: максимум 16 кадров / 128 событий /
4 watchpoint-байта / 1000 мс. Отдельные бюджеты: установка 20 мс, целый
инструментированный кадр 50 мс, суммарная консервативная работа 250 мс.
Это ограничители аварийного выхода, а не приемлемые целевые задержки игры.

Probe hard caps — 4096 событий, 120 кадров, 32 watchpoints и 5000 мс.
Достижение event cap завершает окно; `partialWindow/overflow/endedDuringFrame`
явно отмечают неполное покрытие. `droppedEvents=0` не означает наблюдение
записей после остановки. Обычный logger получает только числа, причину
и стоимость; сырые значения и writer addresses не сохраняются им.

Pause, save/load, ROM/context/generation, freeze/evaluation/heldout, background,
смена управления и connected manual override завершают окно до следующего
неподходящего кадра. Raw очередь очищается; игра и агент сохраняют свой режим.
Восстановленные старты по-прежнему исключены до классификации происхождения.

Точные команды, итоги общего UI/host/build/lint, APK hash и source identity:
[validation.json](validation.json). Результаты unit, controlled CPU, browser
и Android разделены; предыдущая полная CI-проверка PR1: [pr1-ci.json](pr1-ci.json).
В `validation.json` перечислены изменённые implementation-файлы; отчёты и
логи хранятся рядом отдельно от raw diagnostics пользователя.

```sh
python3 tools/build_nes_trace.py --check
AGOD_TRACE_REPORT=/tmp/agod-nes-write-trace.json node tools/nes_write_trace_check.cjs
node tools/core_probe_check.cjs
NODE_PATH=/path/to/node_modules CHROMIUM_EXECUTABLE=/path/to/chromium node tools/run_ui_checks.cjs
bash tools/check.sh
gradle assembleDebug lintDebug assembleRelease lintRelease
```

## Незавершённые пункты

- Точная cycle timestamp и банковые переключения за пределами проверенного NROM.
- Устранение или допустимость post-detach overhead, подтверждённая на Android.
- PR3: причинность action/no-op/alternative, постоянный реестр независимых
  discovery/calibration/holdout, проверка семантики и полярности.
- PR4: verified reward bridge, исполненное credit window, idempotency, FDB/Best gates.
- PR5: Android длительные сессии/фон/память/батарея, blind ROM и frozen behavior.

Все цели и награды остаются неподтверждёнными. Исследовательские trace-тесты
не доказывают улучшение полного коннектома. Исходный backlog и задержка
durable FDB checkpoint остаются в [общем аудите](../../REMAINING_TZ_AUDIT_RU.md).
Автоматического слияния в `main` нет.
