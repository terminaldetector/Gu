package org.node.flyconsole;

import org.json.JSONObject;

/** Correlation survives failure: a queued old request must not stop a newer game/agent. */
final class LabRequestFailure {
    static JSONObject response(String raw,String operation,String message)throws Exception {
        JSONObject request=new JSONObject(raw);
        long generation=integer(request,"generation");
        JSONObject response=new JSONObject().put("generation",generation).put("operation",operation);
        String detail=message==null?"Ошибка нейронного backend":message;
        if("sample".equals(operation))return response.put("token",integer(request,"token")).put("error",detail).put("buttons",0);
        if(!"configure".equals(operation)&&!"systemButtons".equals(operation))throw new IllegalArgumentException("Unknown request operation");
        return response.put("message",detail);
    }
    private static long integer(JSONObject request,String key)throws Exception {
        Object value=request.get(key);
        if(!(value instanceof Number))throw new IllegalArgumentException("Missing numeric "+key);
        double number=((Number)value).doubleValue();long result=((Number)value).longValue();
        if(!Double.isFinite(number)||result<0||number!=result||number>9007199254740991d)throw new IllegalArgumentException("Invalid "+key);
        return result;
    }
}
