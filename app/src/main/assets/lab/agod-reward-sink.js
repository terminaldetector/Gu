/* AGOD reward port (RewardSink): the one place a consumer - a controller, a
   replay buffer, a learner - receives AGOD's verdict on an executed action.

   agod-objective.js settles an interval into a packet (VERIFIED, PROVISIONAL,
   UNKNOWN or INVALIDATED). This port takes those packets together with what the
   consumer knows about the decision (its index, end frame, epoch, executed
   action, game context) and returns an outcome that says exactly what the
   consumer may do with it. It holds the rules on the consumer side, so no
   consumer can get them wrong, and independently of the objective's own ledger:

     UNKNOWN IS NOT ZERO. An UNKNOWN or INVALIDATED outcome has no `value` key at
       all; its route is 'boundary' (clear temporal credit), never 'feedback'.
       A VERIFIED/PROVISIONAL packet without a finite value is rejected, never
       read as 0.
     PROVISIONAL IS NOT CONFIRMED. It is paid on its own channel; only VERIFIED
       is `confirmed`. Totals keep the two sums apart.
     ONE PAYMENT PER EVENT. A paid event id is never paid again in the same
       context (ROM, platform, core, goal) - across boundaries, restores and
       ROM switches back and forth.
     NO MIXED CONTEXT. Every boundary (restore, reset, ROM change, ...) opens a
       new epoch; a packet settled before it is stale. A packet for another ROM,
       core or goal is refused. Decisions are strictly increasing and end frames
       non-decreasing within an epoch.
     THE REWARD BELONGS TO THE EXECUTED ACTION. An action that did not run to
       completion, or that a human overrode, is not paid, and a packet settled
       for another mask is refused.
     FROZEN IS FROZEN. In 'frozen' mode an accepted outcome is reported but is
       never `learnable`.

   The port computes no reward: every number it passes on came from the
   objective's broker. It is deterministic: the same (packet, meta) stream gives
   the same outcomes. */
(function(root){'use strict';
const REVISION='agod-reward-sink-1';
const PACKET_KINDS=['VERIFIED','PROVISIONAL','UNKNOWN','INVALIDATED'];
const LEDGER_LIMIT=4096;
const frozen=Object.freeze.bind(Object);

function checkContext(c){
 const x=c||{};
 if(typeof x.romSha256!=='string'||!/^[a-f0-9]{64}$/.test(x.romSha256))throw Error('context.romSha256 must be a SHA-256');
 if(typeof x.platform!=='string'||!x.platform)throw Error('context.platform is required');
 if(typeof x.coreRevision!=='string'||!x.coreRevision)throw Error('context.coreRevision is required');
 if(x.goalId!==undefined&&x.goalId!==null&&(typeof x.goalId!=='string'||!x.goalId))throw Error('context.goalId must be a string');
 return frozen({romSha256:x.romSha256,platform:x.platform,coreRevision:x.coreRevision,goalId:x.goalId||null});
}
const keyOf=c=>[c.romSha256,c.platform,c.coreRevision,c.goalId||''].join('|');

function createRewardSink(options){
 const o=options||{};
 const mode=o.mode===undefined?'train':o.mode;
 if(mode!=='train'&&mode!=='frozen')throw Error("mode is 'train' or 'frozen'");
 let context=checkContext(o.context),epoch=0,lastDecision=-Infinity,lastEndFrame=-Infinity,revoked=null;
 const ledgers=new Map();
 const ledgerFor=c=>{const k=keyOf(c);if(!ledgers.has(k))ledgers.set(k,{ids:[],set:new Set()});return ledgers.get(k);};
 for(const id of Array.isArray(o.ledger)?o.ledger:[]){const L=ledgerFor(context);if(typeof id==='string'&&!L.set.has(id)){L.set.add(id);L.ids.push(id);}}
 const totals={verified:{count:0,sum:0},provisional:{count:0,sum:0},unknown:0,invalidated:0,rejected:{},boundaries:{}};

 function outcome(kind,reason,extra){
  const paid=!!extra&&Object.prototype.hasOwnProperty.call(extra,'value');
  return frozen({kind,reason:String(reason||''),route:paid?'feedback':'boundary',accepted:paid,
   confirmed:paid&&kind==='VERIFIED',learnable:paid&&mode==='train',epoch,...(extra||{})});
 }
 function reject(code,reason){totals.rejected[code]=(totals.rejected[code]||0)+1;return outcome('REJECTED',reason,{code});}

 function accept(packet,meta){
  const p=packet,m=meta||{};
  if(!p||typeof p!=='object'||!PACKET_KINDS.includes(p.status))return reject('malformed','not an AGOD settlement packet');
  if(!Number.isInteger(m.epoch)||!Number.isInteger(m.decision)||!Number.isInteger(m.endFrame))
   return reject('malformed','meta needs integer epoch, decision and endFrame');
  if(m.epoch!==epoch)return reject('stale-epoch','settled in epoch '+m.epoch+', the port is in epoch '+epoch+' (a boundary came between)');
  if(m.romSha256!==context.romSha256||m.platform!==context.platform||m.coreRevision!==context.coreRevision)
   return reject('context','the packet belongs to another ROM, platform or core');
  if(context.goalId&&p.goalId!==undefined&&p.goalId!==context.goalId)return reject('context','the packet belongs to another goal');
  if(m.decision<=lastDecision||m.endFrame<lastEndFrame)return reject('out-of-order','decision '+m.decision+' / frame '+m.endFrame+' arrived after decision '+lastDecision+' / frame '+lastEndFrame);
  /* the cursor advances for every in-context packet, paid or not: a later
     packet for an earlier decision stays late */
  lastDecision=m.decision;lastEndFrame=m.endFrame;
  if(revoked){totals.invalidated++;return outcome('INVALIDATED','the objective was revoked: '+revoked);}
  if(p.status==='UNKNOWN'){totals.unknown++;return outcome('UNKNOWN',p.reason||'no verified event');}
  if(p.status==='INVALIDATED'){totals.invalidated++;return outcome('INVALIDATED',p.reason||'invalidated',typeof p.eventId==='string'?{eventId:p.eventId}:{});}
  if(typeof p.eventId!=='string'||!p.eventId)return reject('malformed','a paid packet must name its event');
  if(!Object.prototype.hasOwnProperty.call(p,'value')||!Number.isFinite(p.value))
   return reject('malformed','a '+p.status+' packet without a finite value is not paid (it is never read as 0)');
  const ex=m.executed||{};
  if(ex.complete!==true||ex.manualOverride===true||!Number.isInteger(ex.mask)||!Number.isInteger(ex.frames)||ex.frames<=0)
   return reject('not-executed','the reward belongs to an executed action; this one was incomplete or overridden');
  if(p.executedAction&&Number.isInteger(p.executedAction.mask)&&p.executedAction.mask!==ex.mask)
   return reject('not-executed','the packet was settled for mask '+p.executedAction.mask+', the executed mask is '+ex.mask);
  const L=ledgerFor(context);
  if(L.set.has(p.eventId))return reject('duplicate','event '+p.eventId+' was already paid');
  L.set.add(p.eventId);L.ids.push(p.eventId);if(L.ids.length>LEDGER_LIMIT)L.set.delete(L.ids.shift());
  const channel=p.status==='VERIFIED'?'verified':'provisional';
  totals[channel].count++;totals[channel].sum+=p.value;
  return outcome(p.status,p.reason,{eventId:p.eventId,value:p.value,channel,decision:m.decision,endFrame:m.endFrame,mask:ex.mask});
 }
 /* restore, reset, pause, rom-change, core-change, ... A new context (ROM or
    core change) brings that context's own ledger; switching back restores it. */
 function boundary(reason,nextContext){
  const why=String(reason||'boundary');
  if(nextContext!==undefined){const next=checkContext(nextContext);if(keyOf(next)!==keyOf(context))revoked=null;context=next;}
  epoch++;lastDecision=-Infinity;lastEndFrame=-Infinity;
  totals.boundaries[why]=(totals.boundaries[why]||0)+1;
  return epoch;
 }
 const copy=()=>JSON.parse(JSON.stringify(totals));
 return frozen({REVISION,accept,boundary,
  revoke(reason){revoked=String(reason||'revoked');},
  revoked:()=>revoked,epoch:()=>epoch,context:()=>context,mode:()=>mode,totals:copy,
  exportLedger:()=>ledgerFor(context).ids.slice()});
}

const api={REVISION,createRewardSink};
root.FlyAgodRewardSink=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
