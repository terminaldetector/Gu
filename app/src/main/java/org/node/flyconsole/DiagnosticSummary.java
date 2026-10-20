package org.node.flyconsole;
import org.json.*;

/** A positive field list prevents bridge replies from copying models/ROMs into the recorder. */
final class DiagnosticSummary {
    private static final String[] FIELDS={"operation","configureMs","workerQueueMs","memoryBytes","expectedTrials","token","generation","message","error","saveError","ok","id","layerId","bound","configVersion","valid","completed","complete","reason","referenceRole","leg","nextLeg","registered","skipped","bestUpdated","groupId","role","trained","revision","degraded","available","current","recovery","best","previousBest","fallback","recoveryVerified","bestUnavailable","damagedRecords","closed","beforeFdb","afterFdb","eligible","groups","improvedGroups","regressedGroups","signTestP","alpha","comparisonId","signature","system","romHash","graph_sha256","graphSha256","modelId","backend","neurons","edges","reset","changed","core","sha256","hash","saved","mode","unknown","outcome","confidence"};
    static JSONObject of(JSONObject value)throws Exception{
        JSONObject out=new JSONObject();for(String field:FIELDS)if(value.has(field)){Object child=value.get(field);if(child==JSONObject.NULL||child instanceof String||child instanceof Number||child instanceof Boolean)out.put(field,child);}
        for(String field:new String[]{"sessionId","epoch","frame","estimatedBytes","heapAvailableBytes","singleResetRequired","paused"}){Object child=value.opt(field);if(child==JSONObject.NULL||child instanceof String||child instanceof Number||child instanceof Boolean)out.put(field,child);}
        JSONArray agents=value.optJSONArray("agents");if(agents!=null){JSONArray rows=new JSONArray();for(int i=0;i<Math.min(2,agents.length());i++){JSONObject agent=agents.optJSONObject(i);if(agent!=null)rows.put(of(agent));}out.put("agents",rows);}
        JSONArray reasons=value.optJSONArray("reasons");if(reasons!=null)out.put("reasons",reasons);
        for(String field:new String[]{"data","proof","promotionGate","roles","archive","candidateArchive","referenceArchive","context"}){JSONObject child=value.optJSONObject(field);if(child!=null)out.put(field,of(child));}
        if(value.opt("data") instanceof JSONArray)out.put("items",value.getJSONArray("data").length());
        return DiagnosticJournal.bounded(out);
    }
}
