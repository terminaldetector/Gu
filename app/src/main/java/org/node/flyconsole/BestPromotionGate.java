package org.node.flyconsole;
import org.json.*;
import java.util.*;

/** Read-only statistical gate. A durable native reservation authorizes any eventual role update. */
final class BestPromotionGate {
    private static final int MIN_GROUPS=8;
    private static final double ALPHA=.01;
    static JSONObject assess(JSONObject candidate,JSONObject reference)throws Exception {
        try{return compare(candidate,reference);}catch(Exception malformed){return new JSONObject().put("eligible",false).put("bestUpdated",false).put("reasons",new JSONArray().put("Данные сравнительной проверки повреждены или неполны"));}
    }
    private static JSONObject compare(JSONObject candidate,JSONObject reference)throws Exception {
        LinkedHashSet<String> reasons=new LinkedHashSet<>();Map<String,JSONObject> a=trials(candidate,reasons),b=reference==null?Collections.emptyMap():trials(reference,reasons);
        JSONObject ca=candidate.optJSONObject("context"),cb=reference==null?null:reference.optJSONObject("context");
        if(reference==null)reasons.add("Нет парной замороженной проверки контрольной модели");
        if(ca==null||cb==null||!ca.optString("signature").matches("[a-f0-9]{64}")||!ca.optString("signature").equals(cb.optString("signature")))reasons.add("ROM/core/graph/порты/профиль сравнения не подтверждены");
        if(ca==null||cb==null||!ca.optString("comparisonId").matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")||!ca.optString("comparisonId").equals(cb.optString("comparisonId"))||ca.optInt("holdoutsUsedBefore",-1)!=0||cb.optInt("holdoutsUsedBefore",-1)!=0)reasons.add("Нет предварительно зарегистрированного парного протокола с неиспользованным контролем");
        if(ca==null||cb==null||!ca.optBoolean("feedbackTrusted")||!cb.optBoolean("feedbackTrusted"))reasons.add("Достоверность игрового критерия не подтверждена");
        if(reference!=null&&(!ca.optString("candidateDigest").equals(candidate.optString("beforeFdb"))||!ca.optString("referenceDigest").equals(reference.optString("beforeFdb"))||!ca.optString("candidateDigest").equals(cb.optString("candidateDigest"))||!ca.optString("referenceDigest").equals(cb.optString("referenceDigest"))))reasons.add("Модели не соответствуют зафиксированной паре checkpoint");
        if(!a.keySet().equals(b.keySet()))reasons.add("Стартовые состояния и seed различаются");
        Map<String,double[]> groups=new HashMap<>();boolean regressed=false;
        for(String key:a.keySet())if(b.containsKey(key)){
            JSONObject x=a.get(key),y=b.get(key);if(!x.optString("groupId").equals(y.optString("groupId"))){reasons.add("Происхождение парных стартов различается");continue;}
            String kind=x.optString("evidenceKind","confirmation");if(!kind.equals(y.optString("evidenceKind","confirmation"))||!kind.matches("confirmation|retention"))reasons.add("Назначение контрольного отрезка различается");
            double ax=x.getString("outcome").equals("success")?1:0,by=y.getString("outcome").equals("success")?1:0;if(ax<by)regressed=true;
            if(kind.equals("confirmation")){double[] g=groups.computeIfAbsent(x.getString("groupId"),unused->new double[3]);g[0]+=ax;g[1]+=by;g[2]++;}
        }
        int wins=0,losses=0;for(double[] g:groups.values()){if(g[0]>g[1])wins++;if(g[0]<g[1])losses++;}
        if(groups.size()<MIN_GROUPS)reasons.add("Недостаточно независимых групп: требуется минимум 8");
        if(losses>0||regressed)reasons.add("Есть регресс на удержанном отрезке");
        int n=wins+losses;double p=1;if(n>0){p=0;double term=Math.pow(.5,n);for(int i=0;i<=n;i++){if(i>=wins)p+=term;if(i<n)term=term*(n-i)/(i+1);}}
        double alpha=ca==null?ALPHA:ca.optDouble("alpha",ALPHA);if(!Double.isFinite(alpha)||alpha<=0||alpha>ALPHA||cb!=null&&alpha!=cb.optDouble("alpha",ALPHA)){reasons.add("Неверный бюджет статистической ошибки");alpha=0;}
        if(p>alpha)reasons.add("Улучшение не подтверждено односторонним знаковым тестом");
        JSONArray messages=new JSONArray();for(String reason:reasons)messages.put(reason);
        return new JSONObject().put("eligible",reasons.isEmpty()).put("reasons",messages).put("groups",groups.size()).put("improvedGroups",wins).put("regressedGroups",losses).put("signTestP",p).put("alpha",alpha).put("bestUpdated",false);
    }
    private static Map<String,JSONObject> trials(JSONObject proof,Set<String> reasons)throws Exception {
        Map<String,JSONObject> rows=new HashMap<>();
        if(!proof.optBoolean("valid")||!proof.optBoolean("completed")||!proof.optString("beforeFdb").matches("[a-f0-9]{64}")||!proof.optString("beforeFdb").equals(proof.optString("afterFdb")))reasons.add("Полная frozen-проверка серии не подтверждена");
        JSONArray trials=proof.optJSONArray("trials");if(trials==null||trials.length()<1||trials.length()>32||proof.optInt("expectedTrials",-1)!=trials.length()){reasons.add("Контрольная серия неполна");return rows;}
        for(int i=0;i<trials.length();i++){
            JSONObject row=trials.getJSONObject(i);String state=row.optString("stateHash"),group=row.optString("groupId"),outcome=row.optString("outcome");
            if(!state.matches("[a-f0-9]{64}")||!group.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")||!row.optString("role").equals("control")||row.optBoolean("trained",true)||row.optInt("windows",0)<1||row.optInt("interventions",-1)!=0||!outcome.matches("success|death|not-reached")||!row.optString("confidence").matches("diagnostic|configured")||!proof.optString("beforeFdb").equals(row.optString("beforeFdb"))||!proof.optString("afterFdb").equals(row.optString("afterFdb")))reasons.add("Неизвестный исход, вмешательство или неподтверждённый контрольный отрезок");
            if(outcome.equals("not-reached")){JSONObject c=proof.optJSONObject("context");if(c==null||!c.optBoolean("feedbackTrusted")||!c.optString("criterionType").equals("fly-nes-target-v1")||row.optInt("windows",-1)!=c.optInt("criterionHorizon",-2)||!row.optString("confidence").equals("diagnostic"))reasons.add("Нет подтверждённого фиксированного горизонта результата");}
            String key=state+":"+row.optLong("seed",-1);if(rows.put(key,row)!=null)reasons.add("Повтор одного старта/seed не является независимой проверкой");
        }return rows;
    }
}
