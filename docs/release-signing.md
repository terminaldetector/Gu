# Release signing

GitHub Actions `assembleDebug` artifacts use a runner-generated debug certificate and are **not an update channel**. Checks of alpha06/alpha07/alpha08 found different signer fingerprints. An earlier claim that alpha07 matched alpha06 was incorrect.

The user-facing alpha08 APK is signed after CI verification using the persistent private release key. Keep that private key out of the repository, public releases, channel posts and 4PDA. The owner backup is named `FlyConsole-release-signing-v1.zip` and includes the PKCS12 keystore, password file, certificate fingerprint and signing instructions. Reuse this exact key for subsequent APKs. Do not silently regenerate it.

The official Android Build Tools apksigner is provided by the separate signing-tool workflow. Sign and independently verify the full APK with it, then check package/version and the certificate fingerprint against the owner's backup. The CI APK contains the tested application assets; signing does not modify them.

Existing installations signed by a different debug key cannot be upgraded in place. Before a one-time reinstall, export the model/profile JSON from the old application (and capture an episode start if needed). Keep the original APK and exported JSON until the new installation/import has been checked. ROM and graph identities must match when importing. A change of signature does not imply compatibility with old Android-private storage.

Future automated releases should use this key through an owner-configured GitHub Actions secret, never an Actions cache or repository file. Until then, use the private owner backup for local packaging. The certificate is public; the private key and password are not.
