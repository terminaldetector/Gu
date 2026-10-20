package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class RomLibraryCheck {
    static void check(boolean x,String why){if(!x)throw new AssertionError(why);}
    interface Action{void run()throws Exception;}
    static void fails(Action action,String why)throws Exception{boolean failed=false;try{action.run();}catch(Exception expected){failed=true;}check(failed,why);}
    static void erase(File f)throws Exception{if(f.isDirectory())for(File c:f.listFiles())erase(c);Files.deleteIfExists(f.toPath());}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("rom-library-").toFile();
        try{
            byte[] rom=new byte[32784];rom[0]=78;rom[1]=69;rom[2]=83;rom[3]=26;RomLibrary library=new RomLibrary(root);
            JSONObject first=library.offer("nes",rom,"One.nes");String hash=first.getString("sha256");check(library.last("nes")==null,"unaccepted ROM cannot replace last game");
            library.accept(first);check(library.list().getJSONArray("games").length()==1,"accepted game indexed");check(Arrays.equals(new RomLibrary(root).read("nes",hash),rom),"private copy survives reopen");
            fails(()->library.read("gb",hash),"platform isolation");fails(()->library.find("nes","../bad"),"traversal rejected");
            rom[100]=42;JSONObject second=library.offer("nes",rom,"Two.nes");library.accept(second);check(library.last("nes").getString("sha256").equals(second.getString("sha256")),"last committed game advances");check(library.list().getJSONArray("games").length()==2,"per-ROM catalogue");
            Files.writeString(new File(root,"index.json").toPath(),"corrupt");check(library.list().getBoolean("recoveredIndex"),"corrupt primary index uses verified backup");check(library.last("nes").getString("sha256").equals(hash),"last verified catalogue retained");library.accept(second);
            File blob=new File(root,"nes-"+hash+".rom");Files.writeString(blob.toPath(),"corrupt");fails(()->library.read("nes",hash),"content hash checked before emulation");
            library.delete("nes",hash);check(!blob.exists(),"explicit ROM removal frees copy");check(library.list().getJSONArray("games").length()==1,"other game retained");
            File quota=new File(root,"quota");try(RandomAccessFile file=new RandomAccessFile(quota,"rw")){file.setLength(RomLibrary.MAX_BYTES);}rom[101]=7;fails(()->library.offer("nes",rom,"Three.nes"),"quota refusal explicit");check(library.last("nes").getString("sha256").equals(second.getString("sha256")),"quota cannot replace last accepted game");Files.delete(quota.toPath());
            File index=new File(root,"index.json");byte[] valid=Files.readAllBytes(index.toPath());Files.delete(index.toPath());index.mkdir();Files.writeString(new File(index,"block").toPath(),"block");fails(()->library.accept(second),"atomic index failure explicit");check(library.last("nes")!=null,"failed commit leaves previous verified catalogue");erase(index);Files.write(index.toPath(),valid);
            Files.writeString(index.toPath(),"corrupt");Files.writeString(new File(root,"index.recovery.json").toPath(),"corrupt");fails(()->library.list(),"both corrupt catalogues fail without inventing entries");check(new File(root,"nes-"+second.getString("sha256")+".rom").isFile(),"metadata failure retains ROM copies");
            System.out.println("PASS: accepted-only ROM library, private copies, reopen, platform/hash isolation, corrupt index recovery, failed atomic commit, quota and explicit deletion");
        }finally{erase(root);}
    }
}
