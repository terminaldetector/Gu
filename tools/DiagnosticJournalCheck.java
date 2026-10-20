package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public final class DiagnosticJournalCheck {
    interface Action{void run()throws Exception;}
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static void fails(Action action,String why)throws Exception{boolean failed=false;try{action.run();}catch(Exception expected){failed=true;}check(failed,why);}
    static void erase(File f)throws Exception{if(f.isDirectory())for(File child:f.listFiles())erase(child);Files.deleteIfExists(f.toPath());}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("device-log-").toFile();try{
            File store=new File(root,"journal");DiagnosticJournal journal=new DiagnosticJournal(store,16*1024,3);String run=journal.runId;
            JSONObject context=new JSONObject().put("system","nes").put("romHash","a".repeat(64));journal.marker("foreground",1,10);
            for(int i=0;i<90;i++)journal.append(i%10==0?"error":"info","test","bounded.event",context,new JSONObject().put("message","x".repeat(3000)).put("value",1e-8),i,10+i,false);
            JSONObject status=journal.status();check(status.getLong("bytes")<=48*1024&&status.getInt("segments")==3,"rotation stays within fixed quota");
            File[] segments=store.listFiles((d,n)->n.endsWith(".jsonl"));Arrays.sort(segments,Comparator.comparing(File::getName));Files.writeString(segments[segments.length-1].toPath(),"{interrupted",StandardOpenOption.APPEND);
            DiagnosticJournal reopened=new DiagnosticJournal(store,16*1024,3);check(!run.equals(reopened.runId),"new process has separate run identity");check(reopened.status().getJSONObject("previousProcess").getString("stage").equals("foreground"),"unfinished previous foreground is evidence, never silently labelled a crash");
            reopened.append("fatal","android","process.uncaught",context,new JSONObject().put("message","fixture failure"),100,500,true);reopened.marker("uncaught-exception",100,500);
            JSONObject reply=new JSONObject().put("token","fixture").put("data",new JSONObject().put("id",UUID.randomUUID().toString()).put("configuration",new JSONObject().put("fdb",new JSONObject().put("weights","secret weights"))).put("state",new JSONObject().put("base64","secret ROM"))).put("error","fixture");String projected=DiagnosticSummary.of(reply).toString();check(!projected.contains("secret")&&projected.contains("fixture"),"bridge summary has positive fields, no learned weights or ROM state");
            JSONObject big=new JSONObject().put("message","y".repeat(8000)).put("weights",new JSONArray().put("secret"));String bounded=DiagnosticJournal.bounded(big).toString();check(bounded.length()<3000&&!bounded.contains("secret"),"untrusted frontend event has bounded strings and omitted payloads");
            Map<String,File> attachments=new LinkedHashMap<>();String id=UUID.randomUUID().toString();File proof=new File(root,"proof.json");Files.writeString(proof.toPath(),"{\"valid\":false}");File model=new File(root,"model.json");Files.writeString(model.toPath(),"{\"weights\":\"secret\"}");attachments.put("evaluations/"+id+".json",proof);attachments.put("comparisons/"+id+".json",model);attachments.put("../model.json",model);
            File report=new File(root,"report.zip");reopened.export(report,new JSONObject().put("device","host fixture").put("apkSha256","b".repeat(64)),attachments);
            int eventFiles=0,validRows=0;try(ZipFile zip=new ZipFile(report)){JSONObject manifest=new JSONObject(new String(zip.getInputStream(zip.getEntry("manifest.json")).readAllBytes(),StandardCharsets.UTF_8));check(manifest.getInt("invalidRows")==1,"partial previous-run tail remains explicit");check(manifest.getInt("skippedAttachments")==2,"unsafe attachment/model reservation excluded");JSONArray rows=manifest.getJSONArray("files");for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);ZipEntry entry=zip.getEntry(row.getString("path"));byte[] bytes=zip.getInputStream(entry).readAllBytes();check(DiagnosticJournal.sha(bytes).equals(row.getString("sha256")),"export content matches manifest SHA256");if(entry.getName().startsWith("events/")){eventFiles++;validRows+=row.getInt("validRows");}}check(zip.getEntry("comparisons/"+id+".json")==null,"model data never included");}
            check(eventFiles==3&&validRows>0,"recent context and post-restart fatal survive export");
            check(new DiagnosticJournal(store,16*1024,3).status().getJSONObject("previousProcess").getString("stage").equals("uncaught-exception"),"actual uncaught marker survives next run");
            File broken=new File(root,"unavailable");Files.writeString(broken.toPath(),"blocked");fails(()->new DiagnosticJournal(broken),"storage failure is explicit");fails(()->reopened.append("success","test","bad",context,new JSONObject(),1,1,false),"invalid severity rejected, never called success");
            if(args.length>0){DiagnosticJournal clean=new DiagnosticJournal(new File(root,"clean"));clean.append("info","test","unicode.fixture",context,new JSONObject().put("message","Ошибка… <тест> \u2028").put("tiny",1e-8),10,10,true);clean.export(new File(args[0]),new JSONObject().put("sourceId","java-fixture"),Collections.emptyMap());}
            System.out.println("PASS: bounded rotating persistent device journal, separate runs, interrupted tails, uncaught marker, numeric checksums, export manifest, strict no-model attachments, positive bridge summary and explicit storage errors");
        }finally{erase(root);}
    }
}
