'use strict';
const assert=require('assert');
function compose(mode,manual,agent){
  const norm=m=>{if(m&16)m&=~32;if(m&32)m&=~16;if(m&64)m&=~128;if(m&128)m&=~64;return m;};
  let human=norm(manual),brain=norm(agent);
  if(mode==='off'){brain=norm(manual|agent);human=0;}
  return {human,agent:brain,humanPort:mode==='coop-reverse'?2:1,agentPort:mode==='coop'?2:1};
}
assert.deepStrictEqual(compose('off',1,2),{human:0,agent:3,humanPort:1,agentPort:1});
assert.deepStrictEqual(compose('coop',1,2),{human:1,agent:2,humanPort:1,agentPort:2});
assert.deepStrictEqual(compose('coop-reverse',16,32),{human:16,agent:32,humanPort:2,agentPort:1});
assert.strictEqual(compose('coop',16|32,0).human,16);
console.log('GMode routing checks passed');
