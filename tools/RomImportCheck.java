package org.node.flyconsole;
import java.io.*;import java.util.*;import java.util.zip.*;
public final class RomImportCheck {
 private static byte[] zip(String... names)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();try(ZipOutputStream z=new ZipOutputStream(out)){for(String n:names){z.putNextEntry(new ZipEntry(n));z.write(new byte[]{78,69,83,26,1});z.closeEntry();}}return out.toByteArray();}
 private static void rejected(byte[] bytes)throws Exception{try{RomImport.unpack(bytes,false);throw new AssertionError("invalid ZIP accepted");}catch(IOException expected){}}
 public static void main(String[] args)throws Exception{
  byte[] nes={78,69,83,26,1};if(!Arrays.equals(nes,RomImport.unpack(zip("../game.nes"),false)))throw new AssertionError("bounded path-free ZIP import");rejected(zip("a.nes","b.nes"));rejected(zip("readme.txt"));
  try{RomImport.read(new ByteArrayInputStream(new byte[100]),99);throw new AssertionError("limit");}catch(IOException expected){}
  byte[] raw=new byte[16384];raw[0]=(byte)0;raw[1]=(byte)255;raw[2]=(byte)255;raw[3]=0;raw[6]=2;raw[256]='S';raw[257]='E';raw[258]='G';raw[259]='A';byte[] swapped=raw.clone(),smd=new byte[raw.length+512];
  for(int i=0;i<raw.length;i+=2){swapped[i]=raw[i+1];swapped[i+1]=raw[i];}for(int i=0;i<8192;i++){smd[512+i]=raw[2*i+1];smd[512+8192+i]=raw[2*i];}
  if(!Arrays.equals(raw,RomImport.normalizeSega(swapped))||!Arrays.equals(raw,RomImport.normalizeSega(smd)))throw new AssertionError("canonical ROM identity");
  System.out.println("PASS: bounded ZIP, ambiguity rejection, path-free unpack and canonical Sega SMD/byte-swap identity");
 }
}
