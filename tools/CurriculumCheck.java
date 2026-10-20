package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class CurriculumCheck {
    interface Action{void run()throws Exception;}
    static void check(boolean x,String why){if(!x)throw new AssertionError(why);}
    static void fails(Action a,String why)throws Exception{boolean failed=false;try{a.run();}catch(Exception expected){failed=true;}check(failed,why);}
    static void erase(File f)throws Exception{if(f.isDirectory())for(File c:f.listFiles())erase(c);Files.deleteIfExists(f.toPath());}
    public static void main(String[] args)throws Exception{
        File root=Files.createTempDirectory("curriculum-").toFile();JSONObject c=new JSONObject().put("system","nes").put("romHash","a".repeat(64)).put("graphSha256","b".repeat(64));
        try{
            CurriculumStore store=new CurriculumStore(root);String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString(),d=UUID.randomUUID().toString();
            JSONObject train=store.register(c,a,"1".repeat(64));check(train.getString("role").equals("train"),"initial group trains");
            check(store.register(c,a,"2".repeat(64)).getString("groupId").equals(train.getString("groupId")),"adjacent starts keep trajectory group");store.training(c,a);
            String duplicate=UUID.randomUUID().toString();check(store.register(c,duplicate,"1".repeat(64)).getString("groupId").equals(train.getString("groupId")),"identical state cannot become independent under a new UUID");
            store.register(c,b,"3".repeat(64));JSONObject control=store.register(c,d,"4".repeat(64));check(control.getString("role").equals("control"),"control assigned without manual split");
            fails(()->store.training(c,d),"native training blocked for control");check(!new CurriculumStore(root).role(c,d).getBoolean("trained"),"control persists across process reopen");
            fails(()->store.start(c,d,"5".repeat(64)),"unregistered start cannot enter proof");
            store.register(c,d,"2".repeat(64));check(store.role(c,a).getString("role").equals("excluded")&&store.role(c,d).getString("role").equals("excluded"),"cross-role overlap excludes all related origins");fails(()->store.training(c,duplicate),"all aliases obey exclusion");
            JSONObject other=new JSONObject(c.toString()).put("romHash","c".repeat(64));fails(()->store.role(other,a),"ROM isolation");
            JSONObject c2=new JSONObject(c.toString()).put("graphSha256","d".repeat(64));String one=UUID.randomUUID().toString(),two=UUID.randomUUID().toString(),three=UUID.randomUUID().toString();store.register(c2,one,"8".repeat(64));store.register(c2,two,"9".repeat(64));store.register(c2,three,"a".repeat(64));store.training(c2,one);new CurriculumStore(root).register(c2,three,"8".repeat(64));fails(()->store.training(c2,one),"cached permission invalidated by another store instance merging train/control");
            File backup=new File(root,"catalog.recovery.json");byte[] original=Files.readAllBytes(backup.toPath());Files.delete(backup.toPath());backup.mkdir();Files.writeString(new File(backup,"block").toPath(),"block");long revision=store.role(c,b).getLong("revision");fails(()->store.register(c,b,"6".repeat(64)),"atomic write failure explicit");check(store.role(c,b).getLong("revision")==revision,"failed commit preserves old assignments");erase(backup);Files.write(backup.toPath(),original);
            Files.writeString(new File(root,"catalog.json").toPath(),"corrupt");check(store.describe(c).getBoolean("degraded"),"backup marked degraded");fails(()->store.training(c,b),"older backup cannot authorize forgotten control states");fails(()->store.register(c,UUID.randomUUID().toString(),"7".repeat(64)),"cannot invent new splits after metadata loss");
            Files.writeString(backup.toPath(),"corrupt");fails(()->store.describe(c),"both broken catalogs fail closed");
            System.out.println("PASS: durable automatic train/control, shared trajectory and duplicate-state grouping, transitive exclusion, native training prohibition, reopen, ROM isolation, atomic failure and conservative recovery");
        }finally{erase(root);}
    }
}
