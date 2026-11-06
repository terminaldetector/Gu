/* COMPATIBILITY SHIM. The NES driver implementation now lives in
 * agod-platform-driver.js, which carries the same logic for jsnes alongside the
 * Sega, Game Boy and SNES adapters behind one contract.
 *
 * This file was the original NES-only driver. Keeping both would be two
 * implementations of one driver, so the body is gone and what remains forwards:
 *   - ramHash, which the interface uses to identify a live RAM state;
 *   - create, for any caller still asking for a NES driver by this name.
 *
 * create() here is SYNCHRONOUS, as it always was, because jsnes loads
 * synchronously. The platform driver's own create() is a promise, since two of
 * the four cores load asynchronously. New callers should use
 * FlyAgodPlatformDriver.create({platform:'nes', ...}). */
(function(root){'use strict';
const DRIVER_REVISION='agod-nes-driver-2-shim';
const platform=()=>{
 const api=root.FlyAgodPlatformDriver;
 if(!api)throw new Error('agod-platform-driver.js must be loaded before agod-nes-driver.js');
 return api;
};
function create(options){
 const built=platform().createNesSync(options||{});
 if(built.status!=='READY')
  throw new Error('could not build a NES research driver: '+(built.reason||built.status));
 return built;
}
const api={DRIVER_REVISION,
 get DEFAULT_RAM_BYTES(){return 0x800;},
 create,
 ramHash(bytes){return platform().ramHash(bytes);}};
root.FlyAgodNesDriver=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
