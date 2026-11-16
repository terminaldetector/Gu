'use strict';
// Static invariants of the emulator host, carried over from the deleted
// two_player_mode_check (its learner part went with the learner).
const assert=require('node:assert/strict'),fs=require('node:fs');
const html=fs.readFileSync('app/src/main/assets/lab/index.html','utf8');
const manifest=fs.readFileSync('app/src/main/AndroidManifest.xml','utf8');
const activity=fs.readFileSync('app/src/main/java/org/node/flyconsole/NesLabActivity.java','utf8');
assert(html.includes('id="gameExit"')&&html.includes('id="gameSettings"'),'game mode exposes exit and settings');
assert(html.includes('body.game-mode .screen canvas{height:100%;width:auto;')&&html.includes('object-fit:contain'),'landscape game view preserves the ROM aspect ratio');
assert(manifest.includes('android:screenOrientation="fullUser"')&&manifest.includes('android:configChanges="orientation|screenSize|keyboardHidden"'),'rotation preserves the Activity and the live session');
assert(activity.includes('path.endsWith(".css") ? "text/css"'),'the WebView serves stylesheets as text/css under nosniff');
assert(!/android\.permission\.INTERNET"(?![^>]*tools:node="remove")/.test(manifest),'offline first: INTERNET is never requested');
console.log('PASS: game-mode controls, ROM aspect ratio, rotation without Activity restart, CSS MIME type, no INTERNET permission');
