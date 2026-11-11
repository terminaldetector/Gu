/* Tech-test build configuration. In an ordinary build this file sets nothing.
   tools/build_techtest_set.sh rewrites it for each tech-test APK, so that build
   starts with its own AGOD settings (GU_AGOD_AUTOSTART, GU_AGOD_POLICY,
   GU_AGOD_RETRY_SECONDS) and a visible GU_TECH record of what it is. It is the
   first script the page loads, so every later script sees these values. */
'use strict';
window.GU_TECH=null;
