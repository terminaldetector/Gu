package org.node.flyconsole;

import java.io.*;
import java.util.*;
import java.util.zip.*;

/** Bounded cartridge import. Never extracts archive paths to the filesystem. */
public final class RomImport {
    public static final int MAX_FILE=16*1024*1024;
    public static byte[] read(InputStream in,int limit)throws IOException{
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;
        while((n=in.read(buf))!=-1){if(out.size()+n>limit)throw new IOException("ROM/архив превышает лимит");out.write(buf,0,n);}return out.toByteArray();
    }
    public static byte[] unpack(byte[] file,boolean sega)throws IOException{
        int limit=(sega?8:4)*1024*1024+(sega?512:0);
        if(file.length>=4&&file[0]=='P'&&file[1]=='K'){
            byte[] selected=null;int entries=0,total=0;
            try(ZipInputStream zip=new ZipInputStream(new ByteArrayInputStream(file))){ZipEntry e;
                while((e=zip.getNextEntry())!=null){if(++entries>128)throw new IOException("Слишком много файлов в ZIP");if(e.isDirectory())continue;
                    String name=e.getName().toLowerCase(Locale.ROOT);
                    boolean match=sega?name.matches(".*\\.(bin|md|gen|smd)$"):name.endsWith(".nes");
                    byte[] content=read(zip,Math.min(match?limit:1024*1024,32*1024*1024-total));total+=content.length;
                    if(match){if(selected!=null)throw new IOException("ZIP содержит несколько ROM: оставьте одну игру в архиве");selected=content;}
                }
            }
            if(selected==null)throw new IOException("В ZIP нет подходящего картриджа");file=selected;
        }
        if(file.length>limit)throw new IOException("Картридж превышает лимит режима");
        return sega?normalizeSega(file):file;
    }
    private static long word(byte[] b,int p){return ((long)(b[p]&255)<<24)|((long)(b[p+1]&255)<<16)|((b[p+2]&255)<<8)|(b[p+3]&255);}
    private static boolean vectors(byte[] b){if(b.length<514||(b.length&1)!=0)return false;long pc=word(b,4)&0xffffff,sp=word(b,0);return pc>=8&&pc<b.length&&(pc&1)==0&&((sp&0xff0000)==0xff0000||sp==0x1000000);}
    private static boolean sega(byte[] b){return b.length>272&&b[256]=='S'&&b[257]=='E'&&b[258]=='G'&&b[259]=='A';}
    public static byte[] normalizeSega(byte[] file)throws IOException{
        if(file.length<514||file.length>8*1024*1024+512)throw new IOException("Неверный размер Mega Drive ROM");
        byte[] rom=file;
        if(!sega(file)){
            byte[] swap=file.clone();for(int i=0;i+1<file.length;i+=2){swap[i]=file[i+1];swap[i+1]=file[i];}
            if(sega(swap)&&vectors(swap))rom=swap;
            else if((file.length-512)%16384==0){byte[] raw=new byte[file.length-512];
                for(int o=0;o<raw.length;o+=16384)for(int i=0;i<8192;i++){raw[o+2*i]=file[512+o+8192+i];raw[o+2*i+1]=file[512+o+i];}
                if(vectors(raw))rom=raw;
            }
        }
        if(rom.length>8*1024*1024||!vectors(rom))throw new IOException("Неверные стартовые векторы Mega Drive");
        String header=new String(rom,256,16,java.nio.charset.StandardCharsets.US_ASCII).toUpperCase(Locale.ROOT);
        if(header.contains("32X")||header.contains("MEGA CD"))throw new IOException("Sega CD / 32X требуют другого ядра");return rom;
    }
}
