'use strict';
// S9A/S9B unit check: the grouping rule and the ranking, on constructed
// records, with no emulator involved.
//
// The point of the grouping rule is a negative claim: adjacency and a shared
// encoding must NOT group two fields. That claim is cheap to state and easy to
// get wrong, so it is tested directly here rather than inferred from a
// cartridge run.
const assert=require('node:assert/strict');
const Candidates=require('../app/src/main/assets/lab/agod-candidates.js');

let passed=0;
const ok=(label,condition)=>{assert.ok(condition,label);passed++;console.log('  PASS  '+label);};

function record(options){
 const perStart=options.perStart.map((series,index)=>{
  const movedOnTransition=[];
  for(let i=1;i<series.length;i++)movedOnTransition.push(series[i]!==series[i-1]);
  const steps=[];
  for(let i=1;i<series.length;i++)if(series[i]!==series[i-1])steps.push(series[i]-series[i-1]);
  return {startId:'s'+index,series,movedOnTransition,moved:steps.length>0,
   distinctSteps:new Set(steps).size,step:new Set(steps).size===1?steps[0]:null};
 });
 const values=new Set();
 for(const entry of perStart)for(const value of entry.series)values.add(value);
 const stepsSeen=new Set(perStart.filter(entry=>entry.step!==null).map(entry=>entry.step));
 return {
  field:{address:options.address,width:options.width||1,encoding:options.encoding||'binary',
   encodingDetermined:true,endian:'n/a',step:perStart[0].step,direction:options.direction||'decreasing',
   mask:options.mask===undefined?2:options.mask},
  detectorRevision:'unit',
  causality:{confirmedStarts:options.confirmedStarts===undefined?perStart.length:options.confirmedStarts,
   independentStarts:perStart.length,
   confirmedFraction:(options.confirmedStarts===undefined?perStart.length:options.confirmedStarts)/perStart.length},
  dynamics:{perStart,startsObserved:perStart.length,
   startsWhereItMoved:perStart.filter(entry=>entry.moved).length,
   stepAgreesAcrossStarts:stepsSeen.size===1&&perStart.every(entry=>entry.moved),
   stepsSeen:[...stepsSeen]},
  reachability:{distinctValues:values.size,values:[...values],
   reachedNonZero:[...values].some(value=>value!==0),
   floorValue:options.floorValue===undefined?0:options.floorValue,
   floorHeld:options.floorHeld===undefined?true:options.floorHeld},
  restore:{seriesIdenticalAfterRestore:options.restoreReproducible!==false},
  phase:{movesAfterStartPulse:options.movesAfterStartPulse!==false,resetTested:false},
  separability:{movedUnderNeutralControl:!!options.movedUnderNeutral,
   masksThatMoveThisSpan:options.masksMoving===undefined?1:options.masksMoving,
   constantStepAcrossStarts:stepsSeen.size===1},
  downstream:options.downstream||{status:'NOT-TESTED'}};
}

console.log('1. adjacency and a shared encoding must not group');
{
 /* two adjacent BCD bytes that move on DIFFERENT transitions: the Life Force
    situation, where 922/927/939 were adjacent BCD bytes under one button */
 const a=record({address:922,encoding:'bcd',perStart:[[5,4,4,3],[7,6,6,5]]});
 const b=record({address:923,encoding:'bcd',perStart:[[9,9,8,8],[4,4,3,3]]});
 const grouped=Candidates.groupRecords([a,b]);
 ok('two adjacent BCD bytes moving on different transitions stay in separate groups',
  grouped.groups.length===2);
 const link=grouped.links.find(entry=>entry.a===922&&entry.b===923);
 ok('the adjacency is recorded as a considered-and-rejected link',
  link&&link.reason===null&&link.groupedAnyway===false);
 ok('no link in the whole set grouped on adjacency alone',
  grouped.links.filter(entry=>entry.reason===null&&entry.groupedAnyway).length===0);
}

console.log('2. co-movement on every observed transition does group');
{
 const a=record({address:100,perStart:[[9,8,8,7],[5,4,4,3]]});
 const b=record({address:400,perStart:[[20,18,18,16],[12,10,10,8]]});
 const grouped=Candidates.groupRecords([a,b]);
 ok('identical movement on every transition in every start groups them, even far apart',
  grouped.groups.length===1);
 ok('the reason is recorded as joint dynamics',
  grouped.links.some(entry=>entry.reason==='identical movement on every observed transition'));
}

console.log('3. an observed digit carry groups');
{
 /* low BCD digit wraps 0 -> 99 while the high digit steps by 1 */
 const low=record({address:300,encoding:'bcd',width:1,perStart:[[2,1,0,99],[2,1,0,99]]});
 const high=record({address:301,encoding:'bcd',width:1,perStart:[[5,5,5,4],[5,5,5,4]]});
 const carry=Candidates.carryBetween(low,high);
 ok('the carry is detected',carry.observed===true&&Math.abs(carry.deltaB)===1);
 const grouped=Candidates.groupRecords([low,high]);
 ok('a carry groups the two digits',grouped.groups.length===1);
 ok('and the recorded reason is the carry',
  grouped.links.some(entry=>entry.reason==='observed digit carry'));
}

console.log('4. a single transition is not enough to claim co-movement');
{
 const a=record({address:10,perStart:[[3,2]]});
 const b=record({address:11,perStart:[[8,7]]});
 const co=Candidates.coMovement(a,b);
 ok('one transition does not establish co-movement',co.transitions===1&&co.identical===false);
 ok('and so they are not grouped',Candidates.groupRecords([a,b]).groups.length===2);
}

console.log('5. agreement on an all-moved pattern is not evidence of one quantity');
{
 /* three fields that each move on EVERY transition. They agree trivially: this
    is the normal state of anything driven by the same button, and the first
    version of the rule merged them all. */
 const solid=record({address:200,perStart:[[3,2,1,0],[3,2,1,0],[3,2,1,0]],masksMoving:1});
 const echo=record({address:20,perStart:[[3,2,1,0],[3,2,1,0],[3,2,1,0]],masksMoving:8,
  movedUnderNeutral:true});
 const co=Candidates.coMovement(solid,echo);
 ok('agreement is total but the pattern is not informative',
  co.agreementTotal===true&&co.informative===false&&co.identical===false);
 ok('and the reason is recorded',/all-moved or all-still/.test(co.whyNot));
 const grouped=Candidates.groupRecords([echo,solid]);
 ok('so they are NOT grouped',grouped.groups.length===2);
}

console.log('5a. ranking prefers the better-evidenced candidate');
{
 const solid=record({address:200,perStart:[[3,2,1,0],[3,2,1,0],[3,2,1,0]],masksMoving:1});
 const echo=record({address:20,perStart:[[3,2,1,0],[3,2,1,0],[3,2,1,0]],masksMoving:8,
  movedUnderNeutral:true});
 const flaky=record({address:300,perStart:[[3,2,1,0],[3,3,3,3],[3,2,2,2]],masksMoving:1});
 const ranking=Candidates.rankGroups(Candidates.groupRecords([echo,flaky,solid]),{maxCandidates:6});
 const order=ranking.ordered.map(entry=>entry.address);
 ok('the causally clean, reproducible, separable candidate ranks first: got '+order.join(','),
  order[0]===200);
 /* What the DECLARED weights imply, checked rather than assumed. An earlier
    version of this test asserted that the input-echo byte must rank last. That
    was my assumption, not something the spec says: reproducibility carries
    weight 4 and separability weight 3, so a candidate that fails to reproduce
    across starts ranks BELOW one that merely looks like input echo. The weights
    are pre-registered and are not being changed to match an expectation, so
    the test is corrected instead. */
 ok('both flawed candidates rank below the clean one',
  order.indexOf(20)>order.indexOf(200)&&order.indexOf(300)>order.indexOf(200));
 ok('scores are in [0,1]',ranking.ordered.every(entry=>entry.score.total>=0&&entry.score.total<=1));
 ok('the clean candidate leads by a real margin: '
  +ranking.ordered[0].score.total+' vs '+ranking.ordered[1].score.total,
  ranking.ordered[0].score.total-ranking.ordered[1].score.total>0.05);
 /* RECORDED LIMITATION OF THE PRE-REGISTERED SPEC, not a bug to tune away.
    The input-echo candidate scores 0.784 and the irreproducible one 0.783: the
    declared weights do not meaningfully separate those two failure modes, and
    which of them comes second is decided by a thousandth. The weights are
    pre-registered, so they are NOT being changed now that this is visible; the
    fact is stated here and in the report instead. In the live pipeline a byte
    that moves under the neutral control never reaches the inventory, because
    typing already excludes neutral-moved addresses - so this tie is a property
    of the scoring function rather than a hazard in the current pipeline. */
 const echoScore=ranking.ordered.find(entry=>entry.address===20).score.total;
 const flakyScore=ranking.ordered.find(entry=>entry.address===300).score.total;
 ok('and the spec does NOT separate input echo from irreproducibility: '
  +echoScore+' vs '+flakyScore+' - recorded, not retuned',
  Math.abs(echoScore-flakyScore)<0.01);
}

console.log('5b. grouping must never demote the evidence it grouped');
{
 /* an echo byte and a clean resource that DO share an informative pattern, so
    they are legitimately grouped. The representative must be the clean one:
    with a lowest-address rule the echo would represent the group and the group
    would be ranked on the worse of the two. */
 const clean=record({address:600,perStart:[[9,8,8,7],[5,4,4,3],[7,6,6,5]],masksMoving:1});
 const echo=record({address:20,perStart:[[9,8,8,7],[5,4,4,3],[7,6,6,5]],masksMoving:8,
  movedUnderNeutral:true});
 const grouped=Candidates.groupRecords([echo,clean]);
 ok('an informative shared pattern does group them',grouped.groups.length===1);
 const group=grouped.groups[0];
 ok('and the representative is the better-evidenced member, not the lower address: got '
  +group.representative.field.address,group.representative.field.address===600);
 ok('both members are kept in the record',group.addresses.join(',')==='20,600');
}

console.log('6. a null downstream result cannot sink a candidate');
{
 const withConsumer=record({address:500,perStart:[[3,2,1,0],[3,2,1,0]],
  downstream:{status:'OBSERVED',hasConsumer:true}});
 const nullResult=record({address:501,perStart:[[3,2,1,0],[3,2,1,0]],
  downstream:{status:'OBSERVED',hasConsumer:false}});
 const a=Candidates.scoreRecord(withConsumer),b=Candidates.scoreRecord(nullResult);
 const gap=a.total-b.total;
 ok('a consumer raises the score',gap>0);
 ok('but by no more than its declared weight of 2/19: gap='+gap.toFixed(3),
  gap<=2/19+1e-9);
}

console.log('7. the ranking budget is declared, and overflow is recorded not hidden');
{
 const many=[];
 for(let i=0;i<9;i++)many.push(record({address:100+i*40,perStart:[[3,2,1,0],[3,2,1,0]]}));
 const ranking=Candidates.rankGroups(Candidates.groupRecords(many),{maxCandidates:4});
 ok('all candidates are reported',ranking.ordered.length===9);
 ok('only the budget is evaluated',ranking.withinBudget.length===4);
 ok('the overflow is stated',/recorded and not evaluated/.test(ranking.budgetNote));
}

console.log('8. the spec is frozen and declares its weights');
{
 const spec=Candidates.RANKING_SPEC;
 ok('frozen',Object.isFrozen(spec)&&Object.isFrozen(spec.criteria));
 ok('six criteria',spec.criteria.length===6);
 ok('weights sum to the declared total',
  spec.criteria.reduce((sum,entry)=>sum+entry.weight,0)===spec.totalWeight);
 ok('the functional-effect criterion is not the heaviest',
  spec.criteria.find(entry=>entry.id==='observedFunctionalEffect').weight
   <Math.max(...spec.criteria.map(entry=>entry.weight)));
 let threw=false;
 try{'use strict';spec.totalWeight=1;}catch(_){threw=true;}
 ok('the spec cannot be edited at runtime',threw||spec.totalWeight===19);
}

console.log('\nS9 candidate unit check: '+passed+' assertions passed');
