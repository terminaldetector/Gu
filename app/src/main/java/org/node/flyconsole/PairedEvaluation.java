package org.node.flyconsole;

import org.json.*;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Sequential isolated legs: at most one additional CPU engine, never a swap of live Current. */
final class PairedEvaluation {
    final String id;
    final JSONObject reservation;
    private final Graph graph;
    private final long version;
    private final String liveDigest;
    private IsolatedFdbContext evaluator;
    private FrozenSeries series;
    private String leg="candidate",failure="";
    private int index;
    private JSONObject candidateRef;
    private int observations;
    private boolean reached;
    PairedEvaluation(Graph graph,JSONObject reservation,JSONObject live,long version)throws Exception {
        this.graph=graph;this.reservation=new JSONObject(reservation.toString());this.version=version;id=reservation.getString("id");liveDigest=CheckpointDigest.of(live);open();
    }
    private void open()throws Exception {
        evaluator=new IsolatedFdbContext(graph,reservation.getJSONObject(leg));
        series=new FrozenSeries(reservation.getJSONObject("context"),evaluator.state(),version,reservation.getJSONArray("plan").length());index=0;
    }
    String leg(){return leg;}
    void invalidate(String reason){if(failure.isEmpty())failure=reason;if(series!=null)series.invalidate(reason);}
    private void unchanged(JSONObject live,long configVersion)throws Exception {
        if(version!=configVersion||!liveDigest.equals(CheckpointDigest.of(live)))invalidate("Рабочий Current / конфигурация изменились во время парной проверки");if(!failure.isEmpty())throw new IOException(failure);
    }
    void profile(String profile,String actuator)throws Exception{series.profile(profile,actuator);}
    void arm(JSONObject start,JSONObject live,long configVersion)throws Exception {
        unchanged(live,configVersion);JSONArray plan=reservation.getJSONArray("plan");if(index>=plan.length())throw new IOException("Лишний контрольный старт");JSONObject expected=plan.getJSONObject(index);
        for(String field:new String[]{"stateHash","originId","groupId","seed","startFrame"})if(!String.valueOf(start.get(field)).equals(String.valueOf(expected.get(field)))){invalidate("Старт отличается от предварительно зарегистрированного плана");throw new IOException(failure);}
        start.put("evidenceKind",expected.getString("evidenceKind"));series.arm(start,evaluator.state(),version);evaluator.engine.reset(start.getLong("seed"));observations=0;reached=false;
    }
    JSONObject sample(JSONObject request,JSONObject live,long configVersion,AtomicBoolean cancel)throws Exception {
        unchanged(live,configVersion);series.before(request,evaluator.state(),version);
        if(request.optBoolean("frozen",false)){invalidate("Наблюдения экрана заморожены");throw new IOException(failure);}
        JSONObject context=reservation.getJSONObject("context");boolean observed=false;
        if(context.optString("criterionType").equals("fly-nes-target-v1")){
            if(observations>=context.getInt("criterionHorizon"))throw new IOException("Превышен заранее заданный горизонт оценки");
            JSONObject feedback=request.getJSONObject("gameFeedback");int x=feedback.getInt("x"),y=feedback.getInt("y");if(!feedback.getString("kind").equals("fly-nes-target-v1")||feedback.getDouble("x")!=x||feedback.getDouble("y")!=y||x<0||x>255||y<0||y>255)throw new IOException("Неподтверждённое наблюдение diagnostic RAM");observed=x>=200&&Math.abs(y-100)<=4;
        }
        JSONObject result=evaluator.sample(request,cancel);series.after(evaluator.state(),version);unchanged(live,configVersion);observations++;reached|=observed;
        return result.put("configVersion",version).put("frozenSeriesId",series.id).put("comparisonId",id).put("evaluationLeg",leg);
    }
    void trial(JSONObject result,JSONObject live,long configVersion)throws Exception{
        unchanged(live,configVersion);JSONObject derived=new JSONObject(result.toString()),context=reservation.getJSONObject("context");
        if(context.optString("criterionType").equals("fly-nes-target-v1")){
            // A measured fixed-horizon non-success is an evaluation metric, never a negative reward.
            boolean complete=observations==context.getInt("criterionHorizon")&&result.optString("boundary").equals("limit");
            derived.put("outcome",reached?"success":complete?"not-reached":"unknown").put("confidence",reached||complete?"diagnostic":"unknown");
        }
        series.trial(derived,evaluator.state(),version);index++;
    }
    JSONObject end(JSONObject live,long configVersion,EvaluationArchive archive,ComparisonStore comparisons,boolean abort)throws Exception {
        if(abort)invalidate("Парная проверка остановлена пользователем / ошибкой");try{unchanged(live,configVersion);}catch(Exception invalid){/* Archive failed proofs too. */}
        JSONObject proof=series.finish(evaluator.state(),version),ref=archive.save(proof);
        if(!abort&&failure.isEmpty()&&proof.getBoolean("valid")&&leg.equals("candidate")){
            candidateRef=ref;leg="reference";evaluator=null;open();return new JSONObject().put("id",id).put("nextLeg","reference").put("candidateProof",proof).put("bestUpdated",false);
        }
        return new JSONObject().put("id",id).put("proof",proof).put("candidateArchive",candidateRef==null?JSONObject.NULL:candidateRef).put("referenceArchive",leg.equals("reference")?ref:JSONObject.NULL).put("complete",!abort&&failure.isEmpty()&&leg.equals("reference")&&proof.getBoolean("valid")).put("bestUpdated",false);
    }
}
