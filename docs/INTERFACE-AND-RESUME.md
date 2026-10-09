# FlyConsole alpha17: interface and continuation

The emulator remains the Android launcher. Its shell uses original CSS and a touch quick menu inspired by the organization of RetroArch MaterialUI, with Material-style surfaces, navigation and settings. No RetroArch source or artwork was copied. The browser assets are shipped locally; they need no network or font service.

- Game: screen, eight-way pad, Sega/SNES/NES/GB actions, live network telemetry and pause menu.
- Platforms: system selection, ROM import and diagnostic cartridges.
- Models / 2P: FlyWire or Male CNS, independent player models, Layer Sets and neural configuration.
- Learning: human demonstration, autonomous reward learning and frozen evaluation. Session archives and research parameters remain expandable.
- Laboratory: benchmarks, RAM inspection, interventions, ports and recording.
- Settings: orientation, touch size, Sega 3/6-button controllers and region, external controller, keyboard assignments, telemetry visibility and diagnostics.

The D-pad samples each contact against a three-by-three grid. Its centre is neutral; each corner combines two direction bits. Pointer capture allows sliding through directions, releasing outside the pad, and holding a separate action with another contact. Cancel, focus loss, resize and navigation release input. Existing controller bits and human-demonstration capture are retained. Keyboard assignment replaces the target button's previous keys and reassigns an occupied key explicitly. Null overrides remove default mappings. Bindings are isolated by platform.

## Persistence boundaries

Small versioned neural preferences are keyed by **platform + graph SHA256**. Sega pad and region preferences are platform-specific; display preferences retain their existing global store. Android remembers the selected platform. Single-agent policy slots now include the platform in their key and can read alpha16's old graph-specific slots.

Acquired policy and FDB state use the existing version-2 Layer Set store, not a second learning engine. With automatic saving enabled, a first pause/checkpoint creates a `Продолжение` set; later saves update it. A small pointer keyed by **platform + ROM SHA256 + graph SHA256** selects that set on return. Named sets use the same pointer after explicit load/save. The snapshot contains the profile, ports, policy, Wexo/DeltaW, learning/growth checkpoint, training clock/mode and journal. Original graph and ROM bytes are not duplicated. A serial checkpoint promise prevents concurrent pause/autosave callbacks from creating duplicate recovery sets.

Reopening the same ROM restores its compatible set **paused**. It does not automatically launch learning, restore the console frame, transfer weights between FlyWire and Male CNS, or restore complete LIF dynamic state. A model change initializes new LIF dynamics; matching acquired weights return on that model's next use. Console snapshots remain separate. Preferences for both player cards now save on valid edits, even before starting the pair; their native learned layers still use `DualLayerStore`.

Android platform switches use an explicit acknowledgement from JavaScript after pending teaching, FDB and Layer Set writes finish. `evaluateJavascript` completion alone does not indicate completion of an asynchronous save. Failed saving leaves the old page and platform intact. Backgrounding pauses the pair rather than exiting it. Native FDB feedback continues to commit confirmed learned state to its active Layer Set.

Invalid or mismatched stored checkpoints are reported and do not overwrite their stored weights. Explicitly loading a valid Layer Set clears the blocked continuation. Automatic-save checkboxes retain their meaning. Store limits remain 32 sets / 2 MiB per set; users should export and prune obsolete sets when necessary.

## Validation

`tools/settings_check.cjs` covers direction masks, centre/outside release, remap conflicts/removal and version/platform/model isolation. `tools/polish_ui_check.cjs` runs the production page and real Sega WASM, checks diagonal drag with simultaneous action reaching an actual game frame, quick-menu pause, pad/region/remap reload, FlyWire/Male independent policy and FDB restoration, paused reopen, unsent P1/P2 preference retention and responsive settings.

The existing core, FDB, controller, demonstration, Layer Set, two-agent and portrait/landscape suites remain required in CI. UI model/Android callbacks are fixtures; they are not physical Android tests. Full-model and CPU/GPU tests remain in the Android workflow. No new claim of commercial-game compatibility or behavioral intelligence follows from this interface release.
