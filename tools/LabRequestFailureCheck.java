package org.node.flyconsole;
import org.json.JSONObject;

public final class LabRequestFailureCheck {
    static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        JSONObject sample=LabRequestFailure.response("{\"generation\":7,\"token\":42}","sample","actual backend failure");
        require(sample.getLong("generation")==7&&sample.getLong("token")==42&&sample.getString("error").equals("actual backend failure")&&sample.getInt("buttons")==0,"sample retains generation, token and real failure");
        for(String op:new String[]{"configure","systemButtons"}){
            JSONObject result=LabRequestFailure.response("{\"generation\":9}",op,"rejected");
            require(result.getLong("generation")==9&&result.getString("message").equals("rejected")&&!result.has("token"),"control failure remains correlated");
        }
        for(String malformed:new String[]{"{", "{}", "{\"generation\":\"9\"}","{\"generation\":-1}","{\"generation\":1.5}","{\"generation\":9007199254740992}"}){
            boolean rejected=false;try{LabRequestFailure.response(malformed,"configure","bad");}catch(Exception expected){rejected=true;}require(rejected,"uncorrelated input must not produce a global cancellation");
        }
        boolean rejected=false;try{LabRequestFailure.response("{\"generation\":7}","sample","bad");}catch(Exception expected){rejected=true;}require(rejected,"sample requires its token");
        System.out.println("PASS: native failures preserve exact request correlation, real error detail and reject malformed identifiers");
    }
}
