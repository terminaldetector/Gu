# FlyConsole tech-test APK set

- Commit: `4a0877c188e7525a2f571274b0ee2b2ecc14ecce`
- Base version: 2.2.0-agod (versionCode 42); each APK adds -TNN to the version name.
- Signature: Android debug key of the build machine. Not a release signature.
- All ten install side by side, and next to the normal app; each has its own data.
- GPU inference is not a separate APK: it is the 'Backend' switch inside any of them.
- WebView is debuggable in all of them (debug builds): chrome://inspect over USB.

| APK | Package | Label | Connectomes inside | Default | AGOD autostart | Policy | Retry | Size | Question |
|---|---|---|---|---|---|---|---|---|---|
| T01 | `org.node.flyconsole.nes.tech.t01` | FC-T01 Shell | none | flywire-v783 | false | aggressive | default | 57 MB | Starts at all? Manual play with no connectome bundled (loading one must fail cleanly). |
| T02 | `org.node.flyconsole.nes.tech.t02` | FC-T02 FlyWire | FlyWire | flywire-v783 | false | aggressive | default | 112 MB | FlyWire 783 loads and drives the agent on this device; AGOD off. |
| T03 | `org.node.flyconsole.nes.tech.t03` | FC-T03 MaleCNS | MaleCNS | male-cns-v1.0 | false | aggressive | default | 145 MB | Male CNS loads and fits in memory on this device; AGOD off. |
| T04 | `org.node.flyconsole.nes.tech.t04` | FC-T04 Both noAGOD | FlyWire + MaleCNS | flywire-v783 | false | aggressive | default | 199 MB | Both connectomes bundled, switching between them; AGOD off. |
| T05 | `org.node.flyconsole.nes.tech.t05` | FC-T05 AGOD button | FlyWire | flywire-v783 | false | aggressive | default | 112 MB | AGOD only when the button is pressed: does a run finish and does the status line say so? |
| T06 | `org.node.flyconsole.nes.tech.t06` | FC-T06 AGOD auto | FlyWire | flywire-v783 | true | aggressive | default | 112 MB | Production behaviour: background AGOD after ROM load, aggressive reward tier. |
| T07 | `org.node.flyconsole.nes.tech.t07` | FC-T07 AGOD strict | FlyWire | flywire-v783 | true | strict | default | 112 MB | Background AGOD, verified losses only (no progress tier): compare with T06. |
| T08 | `org.node.flyconsole.nes.tech.t08` | FC-T08 AGOD fast | FlyWire | flywire-v783 | true | aggressive | 10s | 112 MB | Background AGOD retried every 10 s once the game advances: CPU/battery/heat stress. |
| T09 | `org.node.flyconsole.nes.tech.t09` | FC-T09 Full FlyWire | FlyWire + MaleCNS | flywire-v783 | true | aggressive | default | 199 MB | Release candidate: both connectomes, FlyWire by default, background AGOD. |
| T10 | `org.node.flyconsole.nes.tech.t10` | FC-T10 Full MaleCNS | FlyWire + MaleCNS | male-cns-v1.0 | true | aggressive | default | 199 MB | Release candidate with Male CNS by default, background AGOD. |

## SHA-256

```
0c0a2e40af2407ec621aafd27a3934d8db9d1a38058a64bcdb0c9f1c23516c7f  FlyConsole-AGOD-2.2.0-T01-debug.apk
7b089c2f1ac1e1768a85be7aed02119e7141fffda9f3793f95830db3739632c9  FlyConsole-AGOD-2.2.0-T02-debug.apk
1adab378564411d59c9b154fc69ea740739fa95b99790c55ca87ce318855385f  FlyConsole-AGOD-2.2.0-T03-debug.apk
9bcfc3177226070f638ccfc066861b96628f67d50dab83742126ee8c3c5c546d  FlyConsole-AGOD-2.2.0-T04-debug.apk
a93ebc73d71e0c00920c1c7a0eb2fbf5c03b2e99d6085e4aa555cb703d5d5276  FlyConsole-AGOD-2.2.0-T05-debug.apk
e18e85f0b533cf0f1c98f2897332380b0ab0673b7b5f02aacf8db027fa4d8b2e  FlyConsole-AGOD-2.2.0-T06-debug.apk
df445e25cfb38625edb50ec57ac25768109bd445dfd8655be53e9390d77db397  FlyConsole-AGOD-2.2.0-T07-debug.apk
20192333a62de782cf51a6ebcf723847ba756d51e666f81231a547b600efb8e7  FlyConsole-AGOD-2.2.0-T08-debug.apk
b833a3890081c5b59adaf20c599faedc88b676b0b036730594414c49ffddd0cd  FlyConsole-AGOD-2.2.0-T09-debug.apk
3b0a57053f168561c45ac5c684d2c1aa4aee9862a95ab8bcc227691f08f367a7  FlyConsole-AGOD-2.2.0-T10-debug.apk
```

## What each APK was checked for after the build

Package name, launcher label, which connectome files are physically inside the APK,
that it carries its own techtest-config.js and the AGOD modules. None of the ten has
been launched on a device by the build machine.
