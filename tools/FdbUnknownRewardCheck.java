package org.node.flyconsole;

/** Unknown feedback must use boundary(), because zero is a real reward. */
public final class FdbUnknownRewardCheck {
 public static void main(String[] args) {
  Graph g=FdbLearningCheck.graph();GraphDelta delta=new GraphDelta(g.ids.length);
  FdbLearning learner=new FdbLearning(g,delta,FdbLearningCheck.sources(),FdbLearningCheck.targets(),.1,128,32,true);
  for(int i=0;i<8;i++){
   FdbLearning.Decision d=learner.decide("known-"+i,FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);
   learner.feedback(d.id,d.mask,1,.1,6,true,false,null);
  }
  FdbLearningCheck.require(learner.baseline()>0,"fixture must acquire nonzero reward baseline");
  learner.decide("unknown",FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);
  long revision=delta.version(),observations=learner.observations(),automatic=learner.automatic();double baseline=learner.baseline();
  learner.boundary();
  FdbLearningCheck.require(delta.version()==revision&&learner.observations()==observations&&learner.automatic()==automatic&&learner.baseline()==baseline,"unknown boundary preserves learned parameters and baseline");
  for(FdbLearning.Trace t:learner.traces())FdbLearningCheck.require(t.eligibility==0&&t.slowEligibility==0,"unknown boundary clears eligibility");
  FdbLearning.Decision zero=learner.decide("known-zero",FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);
  learner.feedback(zero.id,zero.mask,0,.1,6,true,false,null);
  FdbLearningCheck.require(learner.baseline()<baseline&&learner.automatic()==automatic+1,"numeric zero is a real observation and changes nonzero baseline");
  FdbLearningCheck.require(delta.version()>revision,"zero reward after positive history changes learned weights, demonstrating why unknown must not be zero");
  System.out.println("PASS: production FDB unknown boundary preserves nonzero baseline/parameters and clears temporal credit; numeric zero is distinct");
 }
}
