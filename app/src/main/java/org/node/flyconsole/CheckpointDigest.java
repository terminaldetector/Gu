package org.node.flyconsole;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Whole-state digest: includes eligibility, RNG, thresholds and counters, not just weights. */
final class CheckpointDigest {
    static String number(Number value){return new java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString();}
    private static String canonical(Object value,boolean legacy)throws Exception {
        if(value==null||value==JSONObject.NULL)return "null";
        if(value instanceof JSONObject){JSONObject o=(JSONObject)value;List<String> keys=new ArrayList<>();o.keys().forEachRemaining(keys::add);Collections.sort(keys);StringJoiner join=new StringJoiner(",","{","}");for(String k:keys)join.add(JSONObject.quote(k)+":"+canonical(o.get(k),legacy));return join.toString();}
        if(value instanceof JSONArray){JSONArray a=(JSONArray)value;StringJoiner join=new StringJoiner(",","[","]");for(int i=0;i<a.length();i++)join.add(canonical(a.get(i),legacy));return join.toString();}
        if(value instanceof String)return JSONObject.quote((String)value);
        if(value instanceof Number)return legacy?JSONObject.numberToString(value instanceof java.math.BigDecimal?Double.valueOf(((Number)value).doubleValue()):(Number)value):number((Number)value);
        if(value instanceof Boolean)return value.toString();throw new IllegalArgumentException("Неверное значение checkpoint");
    }
    private static String digest(JSONObject state,boolean legacy)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(canonical(state,legacy).getBytes(StandardCharsets.UTF_8)))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    static String of(JSONObject state)throws Exception{return digest(state,false);}
    static boolean matches(JSONObject state,String expected)throws Exception{return of(state).equals(expected)||digest(state,true).equals(expected);}
}
