package org.node.flyconsole;

import java.io.*;
import java.util.*;
import java.util.zip.*;

/** Bounded cartridge import. Never extracts archive paths to the filesystem. */
public final class RomImport {
    public static final int MAX_FILE=64*1024*1024;
    public static byte[] read(InputStream in,int limit)throws IOException{
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;
        while((n=in.read(buf))!=-1){if(out.size()+n>limit)throw new IOException("ROM/архив превышает лимит");out.write(buf,0,n);}return out.toByteArray();
    }
    public static byte[] unpack(byte[] file,boolean sega)throws IOException{
        int limit=(sega?32:4)*1024*1024+(sega?512:0);
        if(file.length>=4&&file[0]=='P'&&file[1]=='K'){
            byte[] selected=null;int entries=0,total=0;
            try(ZipInputStream zip=new ZipInputStream(new ByteArrayInputStream(file))){ZipEntry e;
                while((e=zip.getNextEntry())!=null){if(++entries>128)throw new IOException("Слишком много файлов в ZIP");if(e.isDirectory())continue;
                    String name=e.getName().toLowerCase(Locale.ROOT);
                    boolean match=sega?name.matches(".*\\.(bin|md|gen|smd|mdx|rom)$"):name.endsWith(".nes");
                    byte[] content=read(zip,Math.min(match?limit:1024*1024,64*1024*1024-total));total+=content.length;
                    if(match){if(selected!=null)throw new IOException("ZIP содержит несколько ROM: оставьте одну игру в архиве");selected=content;}
                }
            }
            if(selected==null)throw new IOException("В ZIP нет подходящего картриджа");file=selected;
        }
        if(file.length>=2&&(file[0]&255)==0x1f&&(file[1]&255)==0x8b){
            try(GZIPInputStream gzip=new GZIPInputStream(new ByteArrayInputStream(file))){file=read(gzip,limit);}
        }
        if(file.length>limit)throw new IOException("Картридж превышает лимит режима");
        return sega?normalizeSega(file):file;
    }
    private static long word(byte[] b,int p){return ((long)(b[p]&255)<<24)|((long)(b[p+1]&255)<<16)|((b[p+2]&255)<<8)|(b[p+3]&255);}
    private static boolean vectors(byte[] b){
        if(b.length<514)return false;
        long pc=word(b,4)&0xffffff;
        // Zero SSP is valid: the first push wraps into the top of work RAM.
        return pc>=8&&pc<b.length&&(pc&1)==0;
    }
    private static boolean sega(byte[] b,int offset){return b.length>=offset+272&&b[offset+256]=='S'&&b[offset+257]=='E'&&b[offset+258]=='G'&&b[offset+259]=='A';}
    private static byte[] swapped(byte[] b){byte[] r=b.clone();for(int i=0;i+1<b.length;i+=2){r[i]=b[i+1];r[i+1]=b[i];}return r;}
    public static byte[] normalizeSega(byte[] file)throws IOException{
        if(file.length<514||file.length>32*1024*1024+512)throw new IOException("Неверный размер Mega Drive ROM (до 32 МиБ)");
        byte[] rom=file;
        if(!sega(file,0)){
            byte[] swap=swapped(file);
            if(sega(swap,0))rom=swap;
            else if(file.length>1026&&sega(file,512))rom=Arrays.copyOfRange(file,512,file.length);
            else if(file.length>1026&&sega(swap,512))rom=Arrays.copyOfRange(swap,512,swap.length);
            else {
                for(int offset:new int[]{512,0})if(file.length>offset&&(file.length-offset)%16384==0){
                    byte[] raw=new byte[file.length-offset];
                    for(int o=0;o<raw.length;o+=16384)for(int i=0;i<8192;i++){raw[o+2*i]=file[offset+o+8192+i];raw[o+2*i+1]=file[offset+o+i];}
                    if(sega(raw,0)||(offset==512&&(file[8]&255)==0xaa&&(file[9]&255)==0xbb&&vectors(raw))){rom=raw;break;}
                }
                if(rom==file&&file.length>518){byte[] raw=Arrays.copyOfRange(file,4,file.length-1);for(int i=0;i<raw.length;i++)raw[i]^=0x40;if(sega(raw,0))rom=raw;}
            }
        }
        if(rom.length>32*1024*1024||(!sega(rom,0)&&!vectors(rom)))throw new IOException("Не распознан картридж Mega Drive; проверьте формат и целостность файла");
        String header=new String(rom,256,16,java.nio.charset.StandardCharsets.US_ASCII).toUpperCase(Locale.ROOT);
        if(header.contains("32X")||header.contains("MEGA CD"))throw new IOException("Sega CD / 32X требуют другого ядра");
        if((rom.length&1)!=0){rom=Arrays.copyOf(rom,rom.length+1);rom[rom.length-1]=(byte)255;}
        return rom;
    }
}
