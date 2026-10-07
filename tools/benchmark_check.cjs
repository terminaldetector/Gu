const assert=require('node:assert/strict'),{summary}=require('../app/src/main/assets/lab/benchmark.js');
const a=summary([{outcome:'success',frames:60,wall_ms:1000},{outcome:'timeout',frames:30,wall_ms:1000},{outcome:'manual_control',frames:10,wall_ms:500}]);
assert.equal(a.success_rate,.5);assert.equal(a.completed,2);assert.equal(a.interrupted,1);assert.equal(a.measured_fps,40);assert(a.wilson95[0]<.5&&a.wilson95[1]>.5);assert.equal(summary([]).success_rate,null);assert.equal(summary([]).wilson95,null);
console.log('PASS: benchmark completion denominator, interruption, measured FPS and Wilson confidence interval');
