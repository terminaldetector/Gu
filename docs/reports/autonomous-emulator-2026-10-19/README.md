# GU Autonomous Learning Emulator — проверка первого среза

Дата: 19 октября 2026. Рабочая ветка `feature/autonomous-learning-emulator`,
база `6d772bd` (production `3462e05`). Направление и незавершённые этапы описаны
в [технической стратегии](../../AUTONOMOUS_LEARNING_EMULATOR_RU.md).
Это отчёт разработки; готовность всех платформ и релиза не заявляется.

## Подтверждённые проверки

| Проверка | Результат |
|---|---|
| `tools/neural_isolation_check.cjs` | PASS: четыре frontend с подставленными сбоями; реальный NES продолжает работу после ошибки сети; ручное управление, stale replies, различие core/neural ошибок |
| `tools/save_states_check.cjs` | PASS: SHA256, ROM/core изоляция, detached snapshot, слоты/ревизии, ошибки квоты, резерв, валидируемый перенос legacy |
| `tools/save_states_ui_check.cjs` | PASS: автоснимок без графа; очередь записей; смена ROM, повторная загрузка, ожидание dual ACK; поздний отказ после resume не останавливает игру; rollback частичного fromJSON |
| `tools/autonomous_console_ui_check.cjs` в Chromium | PASS: production-страница и настоящий NES без native графа; даты/превью/перезагрузка; async quick menu; загрузка игры сохраняет веса и FDB; восемь слотов NES в IndexedDB, legacy-перенос, атомарный rollback, конкурентный CAS и recovery; задержанный bind ACK запрещает первый sample, даже при отключённом autosave |
| `tools/fdb_feedback_check.cjs` | PASS: 35 проверок production-протокола: unknown без `reward:0`, bind ACK при конкурентном drain, устаревшие ошибки/таймауты не блокируют новый контекст |
| `tools/fdb_reward_check.cjs` | PASS: явные критерии/контекст, диагностическая идентичность, неизвестный результат |
| `tools/FdbUnknownRewardCheck.java` | PASS: при ненулевом baseline unknown очищает eligibility без мутации; настоящий числовой ноль меняет параметры |
| `tools/LayerSetStoreCheck.java` | PASS: legacy, SHA256, первое резервное поколение, повреждение, reopen, recovery warning, ошибки атомарной записи, физическая квота |
| `tools/dual_ui_check.cjs` / `DualAgentCheck.java` | PASS: unknown без награды, frozen без скрытой мутации, сброс frame fence после ACK boundary |
| `tools/LabRequestFailureCheck.java` | PASS: привязка native ошибок к поколению и токену запроса |
| `tools/current_layer_check.cjs` | PASS: durable record и resume pointer до bind, независимо autosave, ошибки записи/ACK, конкурентные вызовы, смена контекста, reload |
| `tools/current_gate_check.cjs` | PASS: первый sample только после ACK; ручной NES во время ожидания; устаревшие ответы; invalidation без сохранения на каждом кадре |
| `tools/FdbLayerBindingCheck.java` | PASS: реальное native хранилище; контекст/конфигурация, ошибка записи, блокировка мутаций и повторное сохранение |
| Общий `bash tools/check.sh` | **PASS полностью** после сборки Sega API6 и GB/SNES: включая игровые FDB/expanded-проверки, hardware controls, snapshots, Worker и ReleaseCheck |
| `gradle --no-daemon assembleDebug lintDebug` | PASS: повторная сборка после углублённых исправлений; lint 0 errors / 19 warnings |
| `apksigner verify --verbose` | PASS: подпись debug APK, v2 |
| Все 13 browser suites из CI | PASS: layout/interface/landscape, layer/platform/training, dual, polish, training flow, release, autonomous, plasticity speed, action hold |
| `git diff --check` | PASS |

Java использует JDK 17.0.18; Node 24.19.0, Python 3.12.14. Браузерный тест
использует Playwright 1.51.1 и системный Chromium. Он включён в существующий
CI-блок browser-проверок; остальные новые регрессии — в `tools/check.sh`.
Browser-фикстуры приведены к реальному асинхронному контракту: ждут
`loaded && !romLoading`, durable Current и bind ACK; передают полные ROM metadata.
Тесты временной привязки награды используют явно заданный RAM-источник;
неоценённая ручная игра отдельно проверена как unknown без отправки reward.
Исходные проверки не отключались. Скоростные проверки выполнены после окончания
тяжёлого host-прогона: ×1/×3 выдержаны на четырёх ядрах, искусственный overload
показывает фактическую скорость. Удержание кнопок при ×1/×3/×10: 0 разрывов
во всех 12 случаях. Native ответы в этих browser suites являются фикстурами;
они не доказывают нейронную производительность на телефоне.

Для Layer Set backup проверены ошибки записи файлов, а не аппаратное выключение
Android. Ни VM-проверки маршрутизации, ни APK compilation не заменяют запуск ядер.

Результаты игровых regression-прогонов сохранены отдельно:
[FDB comparison](fdb-comparison.json) и [expanded comparison](expanded-comparison.json).
Они используют небольшие mechanism-фикстуры и диагностические ROM; это не
доказательство обучения полного коннектома на произвольной коммерческой игре.

## Исходные измерения всех платформ

Полные данные: [all-platform-host-baseline.json](all-platform-host-baseline.json).
Команда: `GU_BASELINE_FRAMES=18000 node --expose-gc tools/emulator_baseline.cjs <output>`.
Для каждой платформы: 180 прогревочных и 18000 измеряемых кадров оригинального
diagnostic ROM. Сборки и тесты были завершены до измерения.

| Платформа | Host throughput, кадров/s | Frame p95, ms | Snapshot / restore, ms | RSS начало → конец, MiB |
|---|---:|---:|---:|---:|
| NES | 896 | 1.526 | 13.202 / 2.025 | 45.52 → 45.60 |
| SEGA | 1627 | 0.810 | 11.865 / 45.923 | 71.70 → 71.68 |
| GB | 4531 | 0.292 | 6.822 / 16.543 | 92.98 → 102.48 |
| GBC | 4239 | 0.359 | 5.578 / 27.290 | 106.03 → 106.28 |
| SNES | 1280 | 1.133 | 33.662 / 105.016 | 390.40 → 648.86 |

Для всех пяти вариантов подтверждены: 18000 видео callbacks, действующий
аудиотранспорт, повторяемость RAM после save/load, reset и повторный запуск ROM.
Это примерно пять минут **эмулированного** времени на платформу, не длительная
Android-сессия. Нейросеть отключена; темп не ограничен реальным временем.
Периодический GC включён в wall time; frame time измеряет вызовы ядра.
RSS относится ко всему Node-процессу, включая загруженные ранее модули и
инструмент измерения; таблица не доказывает отсутствия утечек.
Аудиосинхронизация, телефонные FPS, neural latency, CPU/GPU-стоимость нейросети
и батарея не измерены. Поля отсутствующих измерений остаются `null`.

Первоначальный отдельный NES-прогон сохранён для истории:
[host-emulator-baseline.json](host-emulator-baseline.json).

## Снятый блокер сборки и комплектность APK

Первоначальная установка Emscripten останавливалась на proxy 403 для
`storage.googleapis.com`. При продолжении доступ проверен повторно: HTTP 200.
Установлены Emscripten **3.1.57** (emsdk commit
`3b3963d86a5c97adaf6eaa845cdfe0b811c2f960`) и отсутствовавший CMake **3.28.4**.
Штатными скриптами собраны Sega API6, Gambatte и Snes9x, сгенерированы
оригинальные диагностические ROM. SHA256 бинарников и source archives сверены
с метаданными. После завершения всех сборок полный `bash tools/check.sh` прошёл.

Подготовлен Male CNS из закреплённых источников с проверкой отпечатков:
165122 нейрона, 25563197 рёбер. APK собран с обоими коннектомами и всеми ядрами;
наличие expanded `brain.fly`, `male-cns.fly`, трёх WASM и соответствующих source
archives проверено внутри APK, подпись v2 валидна. Сборка и lint прошли.
Идентичность артефактов: [core-artifacts.json](core-artifacts.json).
Это проверка комплектности и сборки, не сертификация запуска на телефоне.

В черновике среды обновлены `install_script` и `start_skill`: CMake/Emscripten,
сборка ядер, Playwright и актуальные команды проверок. Сохранение черновика
не означает публикацию нового snapshot. Инструкции учитывают различие старого
`main` и текущей рабочей ветки и запрещают автоматический сброс checkout.

На физическом Android остаются lifecycle/background/Back/контроллер/landscape,
длительная память, звук, battery и CPU/GPU baseline. Первый single-agent sample теперь защищён подтверждённым Current.
P1/P2 всё ещё требуют доказательный lifecycle Best, независимую историю эпизодов,
полный frozen-FDB fingerprint и проверку удержания поведения перед promotion Best.
Manifest Current/Recovery single-agent реализован в дополнении ниже.
Обновление Best, автономное освоение произвольной игры и полная реализация всех
пяти этапов в этой итерации не заявляются.

### Дополнение: защищённые Current/Recovery

Реализован отдельный immutable архив single-agent с SHA256, двумя manifest,
атомарной заменой и проверкой контекста ROM/графа. Best остаётся null.
Повреждённый Recovery явно отмечается. Архив не заменяет поведенческую оценку.

Проверено после изменения:
- `LearnedRolesCheck`: сохранение поколений и идемпотентность, повторное открытие,
  повреждение mutable файлов/поколений/manifest, отказ атомарной записи и квоты,
  безопасная очистка, запрет удаления ссылочных слоёв, изоляция ROM,
  отклонение неподтверждённого Best даже с корректной checksum.
- `current_layer_check.cjs`, `current_gate_check.cjs`: ожидание durable Current,
  native/archive ACK, ошибки записи и устаревшие ответы, восстановление при
  утрате указателя продолжения; ручная эмуляция остаётся доступной.
- Браузерные `layer_ui_check`, `polish_ui_check`, `release_regression_ui_check`,
  `autonomous_console_ui_check`: PASS. Native bridge в браузерных тестах — fixture;
  реальное файловое хранилище отдельно проверено Java-тестами.
- `assembleDebug lintDebug`: BUILD SUCCESSFUL; подпись APK v2 проверена.
  SHA256 и размер текущего APK обновлены в `core-artifacts.json`.

Лимиты: архив 32 МиБ отдельно от mutable-хранилища, максимум 32 контекста.
Checkpoint выполняется при bind и сохранении интерфейса, не после каждого reward.
Потеря питания, Android lifecycle и доказательное продвижение Best ещё не проверены.

Сверка остатка исходного ТЗ от 20 октября: [открытые задачи и условия приёмки](../../REMAINING_TZ_AUDIT_RU.md).

Следующий срез и новая идентичность APK: [20 октября](../autonomous-emulator-2026-10-20/README.md). Метаданные APK в этом отчёте относятся к предыдущему срезу.
