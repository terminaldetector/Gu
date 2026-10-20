package org.node.flyconsole;

import org.json.*;
import java.io.IOException;
import java.util.UUID;

/** Worker-owned proof covering every window, between-window state, and declared LIF-only resets. */
final class FrozenSeries {
    final String id=UUID.randomUUID().toString();
    final long configuration;
    private final String baseline;
    private final JSONObject context;
    private final int expected;
    private final JSONArray trials=new JSONArray();
    private JSONObject current,finished;
    private int windows;
    private long frame=-1;
    private String failure="";
    FrozenSeries(JSONObject context,JSONObject state,long configuration,int expected)throws Exception {
        if(expected<1||expected>32)throw new IOException("Frozen series: 1–32 отрезка");
        this.context=new JSONObject(context.toString());this.baseline=CheckpointDigest.of(state);this.configuration=configuration;this.expected=expected;
    }
    void invalidate(String reason){if(failure.isEmpty())failure=reason;}
    JSONArray trials()throws Exception{return new JSONArray(trials.toString());}
    void profile(String fingerprint,String actuator)throws Exception {if(!context.getString("profileSha256").equals(fingerprint)||!context.getString("actuatorSha256").equals(actuator)){invalidate("Профиль игрового критерия или управления изменился");throw new IOException(failure);}}
    private void check(JSONObject state,long version)throws Exception {
        if(version!=configuration)invalidate("Конфигурация изменилась");
        if(!baseline.equals(CheckpointDigest.of(state)))invalidate("Изменился полный checkpoint FDB");
        if(!failure.isEmpty())throw new IOException("Frozen series: "+failure);
    }
    void arm(JSONObject start,JSONObject state,long version)throws Exception {
        check(state,version);if(finished!=null||current!=null||trials.length()>=expected)throw new IOException("Frozen series: неверная граница отрезка");
        if(!start.getString("stateHash").matches("[a-f0-9]{64}")||!start.getString("role").equals("control")||start.getBoolean("trained")||start.getLong("generation")<0)throw new IOException("Frozen series требует необученный контрольный старт");
        current=new JSONObject(start.toString());windows=0;frame=-1;
    }
    void before(JSONObject request,JSONObject state,long version)throws Exception {
        check(state,version);if(current==null||finished!=null)throw new IOException("Frozen series: отрезок не подготовлен");
        if(!request.optString("learningMode").equals("eval")||!request.optString("controllerSource").equals("exo")||!request.optString("gmode","off").equals("off")||request.getLong("generation")!=current.getLong("generation")||!request.optString("originId").equals(current.getString("originId"))||request.optInt("manualMask",0)!=0||request.optBoolean("intervened",false)){invalidate("Режим, происхождение или ручное вмешательство изменились");check(state,version);}
        if(context.has("actionsHash")&&!context.getString("actionsHash").equals(CheckpointDigest.of(new JSONObject().put("actions",request.getJSONArray("actions"))))){invalidate("Набор действий изменился");check(state,version);}
        if(context.optString("timing").equals("lockstep-1x")&&(!request.optString("runtimeClock").equals("lockstep")||request.optDouble("emulationRate",-1)!=1)){invalidate("Изменился протокол игрового времени");check(state,version);}
        if(windows==0&&frame==-1&&current.has("startFrame")&&request.getLong("frame")!=current.getLong("startFrame")+1){invalidate("Первое наблюдение не соответствует удержанному старту");check(state,version);}
        if(request.getLong("frame")<frame){invalidate("Незаявленный возврат игрового времени");check(state,version);}frame=request.getLong("frame");
    }
    void after(JSONObject state,long version)throws Exception {check(state,version);windows++;}
    void trial(JSONObject result,JSONObject state,long version)throws Exception {
        check(state,version);if(current==null||windows<1)throw new IOException("Frozen series: нет выполненных окон");
        String outcome=result.getString("outcome"),confidence=result.getString("confidence");
        if(!outcome.matches("success|death|not-reached|unknown")||!confidence.matches("diagnostic|configured|unknown")||confidence.equals("unknown")&&!outcome.equals("unknown"))throw new IOException("Frozen series: неподтверждённый исход");
        current.put("outcome",outcome).put("confidence",confidence).put("windows",windows).put("beforeFdb",baseline).put("afterFdb",baseline).put("interventions",0);trials.put(current);current=null;
    }
    JSONObject finish(JSONObject state,long version)throws Exception {
        try{check(state,version);}catch(Exception bad){/* Preserve an explicit failed proof. */}
        if(finished!=null&&!failure.isEmpty()&&finished.getBoolean("valid"))throw new IOException("Замороженное состояние изменилось после завершения; прежний отчёт не относится к новой модели");
        if(finished==null){boolean complete=current==null&&trials.length()==expected;
            finished=new JSONObject().put("version",1).put("type","fly-frozen-series").put("id",id).put("context",context).put("configVersion",configuration).put("expectedTrials",expected).put("trials",new JSONArray(trials.toString())).put("beforeFdb",baseline).put("afterFdb",CheckpointDigest.of(state)).put("valid",failure.isEmpty()&&complete).put("completed",complete).put("reason",failure.isEmpty()&&!complete?"Серия прервана":failure).put("phaseReset","FDB eligibility cleared before begin; only LIF dynamics reset between trials").put("endedAt",System.currentTimeMillis());
        }return new JSONObject(finished.toString());
    }
}
