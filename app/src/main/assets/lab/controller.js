/* Stable controller bits: NES 0..7, Sega extends with X/Y/Z/Mode 8..11. */
(function(root){'use strict';
const layouts={gb:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyX:0,KeyZ:1,Enter:3,ShiftLeft:2,ShiftRight:2},snes:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyA:0,KeyS:1,KeyD:2,KeyQ:8,KeyW:9,KeyE:10,Enter:3,ShiftLeft:11,ShiftRight:11},nes:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyX:0,KeyZ:1,Enter:3,ShiftLeft:2,ShiftRight:2},sega:{ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyA:0,KeyS:1,KeyD:2,KeyQ:8,KeyW:9,KeyE:10,Enter:3,ShiftLeft:11,ShiftRight:11}};
function clean(mask,sega=false){mask&=sega?4095:255;if((mask&48)===48)mask&=~48;if((mask&192)===192)mask&=~192;return mask;}
function keyboard(system,custom={}){const result={...(layouts[system]||layouts.nes)};for(const [code,button] of Object.entries(custom||{})){if(!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(code))continue;if(button===null)delete result[code];else if(Number.isInteger(button)&&button>=0&&button<(system==='sega'||system==='snes'?12:8))result[code]=button;}return result;}
function bind(system,custom,button,code=null){const result={...custom};for(const [key,value] of Object.entries(keyboard(system,custom)))if(value===button)result[key]=null;if(code!==null)result[code]=button;return result;}
// Three zones per axis, with a neutral centre. Leaving the pad releases only this contact.
function dpad(x,y){if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return 0;return (x<1/3?64:x>2/3?128:0)|(y<1/3?16:y>2/3?32:0);}
function axis(x,y,dead=.25){return (y < -dead?16:y > dead?32:0)|(x < -dead?64:x > dead?128:0);}
root.FlyController={clean,keyboard,bind,dpad,axis};if(typeof module!=='undefined')module.exports=root.FlyController;
})(typeof window==='undefined'?globalThis:window);
