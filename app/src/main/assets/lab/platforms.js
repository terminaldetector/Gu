(function(root){'use strict';
const directions=['↑','↓','←','→'];
const platforms={
 nes:{label:'NES',core:'JSNES',buttons:['A','B','Select','Start',...directions],ram:2048,formats:'.nes',ports:2},
 sega:{label:'Sega Mega Drive',core:'Genesis Plus GX',buttons:['A','B','C','Start',...directions,'X','Y','Z','Mode'],ram:65536,formats:'.bin / .md / .gen / .smd / .mdx',ports:2},
 gb:{label:'Game Boy / Game Boy Color',core:'Gambatte',buttons:['A','B','Select','Start',...directions],ram:32768,formats:'.gb / .gbc',ports:1},
 snes:{label:'SNES / Super Famicom',core:'Snes9x',buttons:['A','B','Y','Start',...directions,'X','L','R','Select'],ram:131072,formats:'.sfc / .smc',ports:2}
};
root.FlyPlatforms=platforms;if(typeof module!=='undefined')module.exports=platforms;
})(typeof window==='undefined'?globalThis:window);
