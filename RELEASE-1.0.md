# Fly Console Lab 1.0 — experimental release

Offline Android laboratory with NES, Sega Mega Drive and a programmable JavaScript/JSON interface to a bundled signed FlyWire graph. This release adds transparent model/device diagnostics, measured timings, frozen evaluation trials and JSON reports, plus RAM inspection for configuring external-game rewards and terminal conditions.

Fixed stale replies, graph-load duplication, failed-ROM rollback, shared platform snapshots/CSV, background cancellation, export truncation/size handling, draft persistence and strict inference input validation. Added release regression checks. Existing shared APK updates preserve app ID/signature; GitHub Actions debug APKs use their own certificate.

No commercial ROM is included. Zero Tolerance completion has not been demonstrated; a user-provided ROM and verified game-specific RAM criterion are needed. Native Android phone testing and biological parity are still outstanding. Read README for limitations and measurement interpretation.

Installation: Android 8+ with current System WebView. Enable installation from the app used to open the APK. The full graph is already bundled. Save an external profile/model export before updating; older UI packages lack graph identity and are not silently migrated.
