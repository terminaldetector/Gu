/* Stable controller bits: NES 0..7, Sega extends with X/Y/Z/Mode 8..11. */
(function(root){'use strict';
const layouts={nes:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyX:0,KeyZ:1,Enter:3,ShiftLeft:2,ShiftRight:2},sega:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyA:0,KeyS:1,KeyD:2,KeyQ:8,KeyW:9,KeyE:10,Enter:3,ShiftLeft:11,ShiftRight:11}};
function clean(mask,sega=false){mask&=sega?4095:255;if((mask&48)===48)mask&=~48;if((mask&192)===192)mask&=~192;return mask;}
function keyboard(system,custom={}){return {...layouts[system],...custom};}
function axis(x,y,dead=.25){return (y < -dead?16:y > dead?32:0)|(x < -dead?64:x > dead?128:0);}
root.FlyController={clean,keyboard,axis};if(typeof module!=='undefined')module.exports=root.FlyController;
})(typeof window==='undefined'?globalThis:window);
