package org.node.flyconsole;
import java.io.*;import java.util.*;import java.util.zip.*;
public final class RomImportCheck {
 private static byte[] zip(String... names)throws Exception{return zipData(new byte[]{78,69,83,26,1,0,0,0,0,0,0,0,0,0,0,0},names);}
 private static byte[] zipData(byte[] data,String... names)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();try(ZipOutputStream z=new ZipOutputStream(out)){for(String n:names){z.putNextEntry(new ZipEntry(n));z.write(data);z.closeEntry();}}return out.toByteArray();}
 private static void rejected(byte[] bytes)throws Exception{try{RomImport.unpack(bytes,false);throw new AssertionError("invalid ZIP accepted");}catch(IOException expected){}}
 public static void main(String[] args)throws Exception{
  byte[] nes={78,69,83,26,1,0,0,0,0,0,0,0,0,0,0,0};if(!Arrays.equals(nes,RomImport.unpack(zip("../game.nes"),false)))throw new AssertionError("bounded path-free ZIP import");rejected(zip("a.nes","b.nes"));rejected(zip("readme.txt"));
  try{RomImport.read(new ByteArrayInputStream(new byte[100]),99);throw new AssertionError("limit");}catch(IOException expected){}
  byte[] raw=new byte[16384];raw[0]=(byte)0;raw[1]=(byte)255;raw[2]=(byte)255;raw[3]=0;raw[6]=2;raw[256]='S';raw[257]='E';raw[258]='G';raw[259]='A';byte[] swapped=raw.clone(),smd=new byte[raw.length+512];
  for(int i=0;i<raw.length;i+=2){swapped[i]=raw[i+1];swapped[i+1]=raw[i];}for(int i=0;i<8192;i++){smd[512+i]=raw[2*i+1];smd[512+8192+i]=raw[2*i];}
  if(!Arrays.equals(raw,RomImport.normalizeSega(swapped))||!Arrays.equals(raw,RomImport.normalizeSega(smd)))throw new AssertionError("canonical ROM identity");
  byte[] zeroStack=raw.clone();Arrays.fill(zeroStack,0,4,(byte)0);if(!Arrays.equals(zeroStack,RomImport.normalizeSega(zeroStack)))throw new AssertionError("zero initial SSP rejected");
  byte[] copier=new byte[raw.length+512];System.arraycopy(raw,0,copier,512,raw.length);if(!Arrays.equals(raw,RomImport.normalizeSega(copier)))throw new AssertionError("copier header");
  byte[] headerlessSmd=Arrays.copyOfRange(smd,512,smd.length);if(!Arrays.equals(raw,RomImport.normalizeSega(headerlessSmd)))throw new AssertionError("headerless SMD");
  byte[] mdx=new byte[raw.length+5];for(int i=0;i<raw.length;i++)mdx[i+4]=(byte)(raw[i]^0x40);if(!Arrays.equals(raw,RomImport.normalizeSega(mdx)))throw new AssertionError("MDX identity");
  ByteArrayOutputStream gz=new ByteArrayOutputStream();try(GZIPOutputStream stream=new GZIPOutputStream(gz)){stream.write(raw);}if(!Arrays.equals(raw,RomImport.unpack(gz.toByteArray(),true)))throw new AssertionError("GZIP identity");
  byte[] large=new byte[9*1024*1024];System.arraycopy(raw,0,large,0,raw.length);if(RomImport.normalizeSega(large).length!=large.length)throw new AssertionError("old 8MiB limit");
  try{RomImport.normalizeSega(new byte[16384]);throw new AssertionError("garbage cartridge accepted");}catch(IOException expected){}
  byte[] gb=new byte[32768];gb[0x143]=(byte)128;
  if(!Arrays.equals(gb,RomImport.unpack(zipData(gb,"folder/game.GBC"),"gb")))throw new AssertionError("GBC ZIP");
  byte[] snes=new byte[65536],snesCopier=new byte[66048];snes[10]=42;System.arraycopy(snes,0,snesCopier,512,snes.length);
  if(!Arrays.equals(snes,RomImport.unpack(zipData(snesCopier,"game.smc"),"snes")))throw new AssertionError("SNES canonical hash bytes");
  ByteArrayOutputStream snesGz=new ByteArrayOutputStream();try(GZIPOutputStream stream=new GZIPOutputStream(snesGz)){stream.write(snesCopier);}
  if(!Arrays.equals(snes,RomImport.unpack(snesGz.toByteArray(),"snes")))throw new AssertionError("SNES GZIP");
  try{RomImport.unpack(zipData(gb,"game.gbc"),"snes");throw new AssertionError("wrong platform ZIP");}catch(IOException expected){}
  try{RomImport.unpack(zipData(gb,"a.gb","b.gbc"),"gb");throw new AssertionError("ambiguous GB ZIP");}catch(IOException expected){}
  try{RomImport.normalize(new byte[8*1024*1024+1],"gb");throw new AssertionError("GB limit");}catch(IOException expected){}
  System.out.println("PASS: bounded four-platform ZIP/GZIP, ambiguity rejection and canonical Sega/SNES hash identity");
 }
}
