# V2 alpha release note

Выпуск предназначен для технической проверки на реальном Android-устройстве. Основной сценарий — NES Contra с внешним ROM, режим GMode и сравнение CPU/GPU по CSV-журналу.

### Проверка

CI выполняет Java/JS/ROM regression checks, проверяет GMode routing и контракт OpenGL ES 3.1 shader. APK собирается Gradle workflow; локальная машина без Android SDK не используется как доказательство сборки.

### Что смотреть на устройстве

1. Откройте NES, загрузите свой ROM и выберите GMode.
2. Примените CPU reference, затем повторите тот же seed в GPU compute.
3. Сравните `backend`, spikes, active, wallMs и CSV metadata.
4. Для FDB используйте следующий экран Recursive Lab: `GraphDelta` уже отделяет growth layer от immutable connectome.

Sega остаётся рабочим однопользовательским эмулятором; P2 будет добавлен отдельной пересборкой API3 core.
