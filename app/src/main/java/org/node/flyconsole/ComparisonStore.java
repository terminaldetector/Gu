package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Append-only preregistration. Even interrupted attempts spend their fresh holdout groups. */
final class ComparisonStore {
    private static final Object LOCK=new Object();
    private static final long MAX_BYTES=32L*1024*1024;
    private final File root;
    static final class Unavailable extends IOException {Unavailable(String message){super(message);}}
    ComparisonStore(File root)throws IOException{this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Каталог парных протоколов недоступен");}
    static final class Promotion {
        private final JSONObject candidate,evidence;
        private Promotion(JSONObject candidate,JSONObject evidence)throws Exception{this.candidate=new JSONObject(candidate.toString());this.evidence=new JSONObject(evidence.toString());}
        JSONObject candidate()throws Exception{return new JSONObject(candidate.toString());}
        JSONObject evidence()throws Exception{return new JSONObject(evidence.toString());}
    }
    static String key(JSONObject row)throws Exception{return row.getString("stateHash")+":"+row.getLong("seed");}
    private File file(String id,String suffix)throws IOException {if(!id.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}"))throw new IOException("ID парного протокола");return new File(root,id+suffix+".json");}
    private static JSONObject read(File file)throws Exception {
        if(!file.isFile()||file.length()>9L*1024*1024)throw new IOException("Парный протокол отсутствует / повреждён");JSONObject box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)),data=box.getJSONObject("data");
        if(box.getInt("version")!=1||!box.getString("sha256").equals(CheckpointDigest.of(data)))throw new IOException("SHA256 парного протокола не совпадает");return data;
    }
    private void immutable(File target,JSONObject data)throws Exception {
        byte[] bytes=new JSONObject().put("version",1).put("sha256",CheckpointDigest.of(data)).put("data",data).toString().getBytes(StandardCharsets.UTF_8);
        if(bytes.length>9L*1024*1024)throw new IOException("Парный протокол превышает лимит одной записи");
        if(target.exists()){if(!CheckpointDigest.of(read(target)).equals(CheckpointDigest.of(data)))throw new IOException("Парный протокол уже записан с другим содержимым");return;}
        long total=0;File[] all=root.listFiles();if(all==null||all.length>=128)throw new IOException("Лимит парных протоколов; прежние записи сохранены");for(File f:all){if(!f.isFile())throw new IOException("Каталог протоколов повреждён");total+=f.length();}if(total+bytes.length>MAX_BYTES)throw new IOException("Каталог парных протоколов заполнен");
        File tmp=File.createTempFile("comparison-",".tmp",root);try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}Files.move(tmp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE);}finally{Files.deleteIfExists(tmp.toPath());}
    }
    private static boolean overlaps(JSONObject a,JSONObject b)throws Exception {
        if(a.getString("groupId").equals(b.getString("groupId")))return true;
        for(String field:new String[]{"origins","states"}){Set<String> seen=new HashSet<>();JSONArray x=a.getJSONObject("lineage").getJSONArray(field),y=b.getJSONObject("lineage").getJSONArray(field);for(int i=0;i<x.length();i++)seen.add(x.getString(i));for(int i=0;i<y.length();i++)if(seen.contains(y.getString(i)))return true;}return false;
    }
    JSONObject reserve(JSONObject protocol,JSONObject candidate,JSONObject reference,String previousBest,JSONArray coverage,JSONArray proposed)throws Exception {synchronized(LOCK){
        JSONObject context=LearnedRoles.context(candidate);if(!CheckpointDigest.of(context).equals(CheckpointDigest.of(LearnedRoles.context(reference))))throw new IOException("Контрольная модель другой игры / сети");
        if(proposed.length()<1||proposed.length()>32)throw new IOException("Для сравнения нужно 1–32 удержанных старта");
        Map<String,JSONObject> priorCoverage=new HashMap<>();for(int i=0;i<coverage.length();i++)priorCoverage.put(key(coverage.getJSONObject(i)),coverage.getJSONObject(i));
        JSONArray plan=new JSONArray();Set<String> keys=new HashSet<>();
        for(int i=0;i<proposed.length();i++){
            JSONObject row=new JSONObject(proposed.getJSONObject(i).toString());String key=key(row);
            if(!keys.add(key)||!row.getString("stateHash").matches("[a-f0-9]{64}")||!row.getString("groupId").matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")||!row.getString("role").equals("control")||row.getBoolean("trained")||row.getLong("seed")<0||row.getLong("seed")>0x7fffffffL||row.getLong("startFrame")<0)throw new IOException("Неверный / обученный / повторный контрольный старт");
            JSONObject old=priorCoverage.get(key);if(old!=null&&(!old.getString("groupId").equals(row.getString("groupId"))||!old.getString("originId").equals(row.getString("originId"))))throw new IOException("Происхождение прежней контрольной задачи изменилось");
            row.put("evidenceKind",old==null?"confirmation":"retention");plan.put(row);
        }
        if(!keys.containsAll(priorCoverage.keySet()))throw new Unavailable("В плане нет всех прежних задач Best: проверка сохранения поведения неполна");
        boolean fresh=false;for(int i=0;i<plan.length();i++)fresh|=plan.getJSONObject(i).getString("evidenceKind").equals("confirmation");if(!fresh)throw new Unavailable("Нет новых независимых контрольных групп");
        File[] all=root.listFiles();if(all==null)throw new IOException("Каталог протоколов не читается");int attempt=1;
        for(File f:all){if(!f.getName().matches("[a-f0-9-]{36}(\\.result)?\\.json"))throw new IOException("Неполная запись протокола: новая проверка заблокирована");if(f.getName().endsWith(".result.json")){read(f);continue;}
            JSONObject used=read(f);if(!CheckpointDigest.of(used.getJSONObject("domain")).equals(CheckpointDigest.of(context)))continue;attempt++;
            JSONArray oldPlan=used.getJSONArray("plan");for(int i=0;i<plan.length();i++){JSONObject row=plan.getJSONObject(i);if(!row.getString("evidenceKind").equals("confirmation"))continue;for(int j=0;j<oldPlan.length();j++)if(overlaps(row,oldPlan.getJSONObject(j)))throw new Unavailable("Контрольная группа уже использована; повтор не является новым подтверждением");}
        }
        String id=UUID.randomUUID().toString(),candidateDigest=CheckpointDigest.of(candidate.getJSONObject("configuration").getJSONObject("fdb")),referenceDigest=CheckpointDigest.of(reference.getJSONObject("configuration").getJSONObject("fdb"));
        JSONObject c=new JSONObject(protocol.toString()).put("comparisonId",id).put("candidateDigest",candidateDigest).put("referenceDigest",referenceDigest).put("holdoutsUsedBefore",0).put("alpha",.01/(attempt*(double)(attempt+1))).put("attempt",attempt).put("planSha256",CheckpointDigest.of(new JSONObject().put("plan",plan)));
        JSONObject reservation=new JSONObject().put("version",1).put("id",id).put("domain",context).put("context",c).put("plan",plan).put("previousBest",previousBest==null?JSONObject.NULL:previousBest).put("candidate",new JSONObject(candidate.toString())).put("reference",new JSONObject(reference.toString())).put("registeredAt",System.currentTimeMillis());
        immutable(file(id,""),reservation);return new JSONObject(reservation.toString());
    }}
    private static void matches(JSONObject proof,JSONObject reservation,String leg)throws Exception {
        if(!CheckpointDigest.of(proof.getJSONObject("context")).equals(CheckpointDigest.of(reservation.getJSONObject("context"))))throw new IOException("Frozen proof другого предварительного протокола");
        if(!proof.getString("beforeFdb").equals(reservation.getJSONObject("context").getString(leg+"Digest")))throw new IOException("Frozen proof другой модели");
        JSONArray plan=reservation.getJSONArray("plan"),rows=proof.getJSONArray("trials");if(rows.length()!=plan.length())throw new IOException("Неполная парная серия");
        for(int i=0;i<plan.length();i++)for(String field:new String[]{"stateHash","originId","groupId","seed","startFrame","evidenceKind"})if(!String.valueOf(plan.getJSONObject(i).get(field)).equals(String.valueOf(rows.getJSONObject(i).get(field))))throw new IOException("Контрольные старты отличаются от зарегистрированного плана");
    }
    static JSONObject verifyEvidence(JSONObject evidence,JSONObject candidate)throws Exception {
        JSONObject reservation=evidence.getJSONObject("reservation"),a=evidence.getJSONObject("candidateProof"),b=evidence.getJSONObject("referenceProof");
        if(!reservation.getString("id").equals(reservation.getJSONObject("context").getString("comparisonId"))||!CheckpointDigest.of(new JSONObject().put("plan",reservation.getJSONArray("plan"))).equals(reservation.getJSONObject("context").getString("planSha256")))throw new IOException("План подтверждения Best повреждён");
        matches(a,reservation,"candidate");matches(b,reservation,"reference");
        if(!CheckpointDigest.of(candidate.getJSONObject("configuration").getJSONObject("fdb")).equals(a.getString("beforeFdb"))||!CheckpointDigest.of(LearnedRoles.context(candidate)).equals(CheckpointDigest.of(reservation.getJSONObject("domain"))))throw new IOException("Best не соответствует проверенному checkpoint");
        JSONObject gate=BestPromotionGate.assess(a,b);if(!gate.getBoolean("eligible"))throw new IOException("Best не прошёл парную проверку: "+gate.getJSONArray("reasons"));return gate;
    }
    Promotion conclude(String id,EvaluationArchive archive,JSONObject candidateRef,JSONObject referenceRef)throws Exception {synchronized(LOCK){
        JSONObject reservation=read(file(id,"")),candidate=reservation.getJSONObject("candidate"),a=archive.read(candidateRef),b=archive.read(referenceRef);
        matches(a,reservation,"candidate");matches(b,reservation,"reference");JSONObject gate=BestPromotionGate.assess(a,b);
        JSONObject metadata=new JSONObject(reservation.toString());metadata.remove("candidate");metadata.remove("reference");
        JSONObject evidence=new JSONObject().put("version",1).put("reservation",metadata).put("candidateProof",a).put("referenceProof",b);
        immutable(file(id,".result"),new JSONObject().put("id",id).put("candidateArchive",candidateRef).put("referenceArchive",referenceRef).put("gate",gate));
        if(!gate.getBoolean("eligible"))return null;verifyEvidence(evidence,candidate);return new Promotion(candidate,evidence);
    }}
}
