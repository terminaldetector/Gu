package org.node.flyconsole;
import org.json.*;
public final class FdbDiagnosticsCheck {
 public static void main(String[] args)throws Exception{
  Graph g=FdbTemporalExperiment.graph();GraphDelta d=new GraphDelta(30);d.addWeightDelta(0,16,2);FdbLearning l=FdbLearningCheck.learner(g,d);l.creditProfile("dual-v1");
  for(int i=0;i<120;i++)FdbDualCreditCheck.step(l,i,FdbLearningCheck.active(),0);
  JSONObject report=FdbDiagnostics.report(g,d,l);FdbDualCreditCheck.check(report.getJSONArray("recent100").length()==100,"bounded recent events");JSONObject e=report.getJSONArray("rootTop20").getJSONObject(0);FdbDualCreditCheck.check(e.get("source") instanceof String&&e.getDouble("w0")==20&&e.getDouble("effectiveWeight")==22,"exact 64-bit string identity and W0 report");
  System.out.println("PASS: bounded FDB report, W0/effective delta, string 64-bit identities");
 }
}
