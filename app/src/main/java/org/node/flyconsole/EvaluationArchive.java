package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;

/** Immutable full-series proofs, including failures. No proof is itself a Best promotion. */
final class EvaluationArchive {
    private final File root;
    EvaluationArchive(File root)throws IOException{this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Архив проверки недоступен");}
    synchronized JSONObject read(JSONObject ref)throws Exception {
        String id=ref.getString("id");if(!id.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}"))throw new IOException("Неверный ID доказательства");
        File file=new File(root,id+".json");if(!file.isFile()||file.length()>128*1024)throw new IOException("Доказательство отсутствует / превышает лимит");
        JSONObject box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)),report=box.getJSONObject("report");String digest=CheckpointDigest.of(report);
        if(box.getInt("version")!=1||!id.equals(report.getString("id"))||!CheckpointDigest.matches(report,box.getString("sha256"))||!box.getString("sha256").equals(ref.getString("sha256")))throw new IOException("SHA256 доказательства не совпадает");return report;
    }
    synchronized JSONObject save(JSONObject report)throws Exception {
        String id=report.getString("id");if(!id.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}"))throw new IOException("Неверный ID проверки");
        File target=new File(root,id+".json");String digest=CheckpointDigest.of(report);JSONObject box=new JSONObject().put("version",1).put("sha256",digest).put("report",report);byte[] bytes=box.toString().getBytes(StandardCharsets.UTF_8);
        if(target.exists()){JSONObject old=new JSONObject(new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));if(!old.getString("sha256").equals(digest)||!CheckpointDigest.of(old.getJSONObject("report")).equals(digest))throw new IOException("Запись проверки уже существует или повреждена");return new JSONObject().put("id",id).put("sha256",digest);}
        long occupied=0;File[] files=root.listFiles();if(files==null||files.length>=128)throw new IOException("Лимит архива проверок");for(File f:files)occupied+=f.length();if(bytes.length>128*1024||occupied+bytes.length>4L*1024*1024)throw new IOException("Архив проверок заполнен; прежние доказательства сохранены");
        File tmp=File.createTempFile("proof-",".tmp",root);try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}Files.move(tmp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE);}finally{Files.deleteIfExists(tmp.toPath());}
        return new JSONObject().put("id",id).put("sha256",digest);
    }
}
