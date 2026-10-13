package org.node.flyconsole;
import android.content.Context;
import android.view.*;
import org.json.*;
import java.util.*;
/** Input-event fixtures verify production routing and packet contents, without claiming hardware tests. */
public final class ControllerInputCheck {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  InputDevice.DEVICES.put(7,new InputDevice("stable-descriptor"));List<JSONObject> packets=new ArrayList<>();ControllerInput input=new ControllerInput(new Context(),packets::add);
  input.enabled(true);JSONObject p=packets.get(packets.size()-1);check(p.getString("descriptor").equals("stable-descriptor")&&p.getInt("mask")==0,"enumerate enabled devices");
  check(!input.key(new KeyEvent(7,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BACK)),"Android Back is not a bindable game button");
  check(input.key(new KeyEvent(7,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BUTTON_A)),"default A accepted");p=packets.get(packets.size()-1);check(p.getInt("mask")==1&&p.getBoolean("pressed"),"default A bit");
  check(input.key(new KeyEvent(7,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BUTTON_L2)),"unmapped trigger is capturable");p=packets.get(packets.size()-1);check(p.getInt("mask")==1&&p.getInt("keyCode")==104&&p.getJSONArray("keyMasks").length()==2,"raw trigger and held A preserved");
  input.motion(new MotionEvent(7,Map.of(MotionEvent.AXIS_X,1f)));p=packets.get(packets.size()-1);check(p.getInt("axisMask")==128&&p.getInt("mask")==129,"axes and held keys merge");
  input.key(new KeyEvent(7,KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BUTTON_A));p=packets.get(packets.size()-1);check(p.getInt("mask")==128&&p.getJSONArray("keyMasks").length()==1,"A release preserves unmapped trigger and direction");
  input.key(new KeyEvent(7,KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BUTTON_L2));input.motion(new MotionEvent(7,Map.of(MotionEvent.AXIS_LTRIGGER,1f)));p=packets.get(packets.size()-1);check(p.getInt("keyCode")==104&&p.getBoolean("pressed")&&p.getJSONArray("keyMasks").length()==1,"analog trigger crosses capture threshold");
  input.motion(new MotionEvent(7,Map.of(MotionEvent.AXIS_LTRIGGER,1f)));p=packets.get(packets.size()-1);check(!p.has("keyCode"),"held analog trigger emits no repeated capture edge");
  input.motion(new MotionEvent(7,Map.of()));p=packets.get(packets.size()-1);check(p.getInt("mask")==0&&p.getJSONArray("keyMasks").length()==0,"analog trigger release reaches browser");
  input.key(new KeyEvent(7,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BUTTON_16));p=packets.get(packets.size()-1);check(p.getInt("keyCode")==203,"numbered gamepad buttons are capturable");
  input.enabled(false);p=packets.get(packets.size()-1);check(p.getInt("mask")==0&&p.getJSONArray("keyMasks").length()==0,"disabling clears every raw source");check(!input.key(new KeyEvent(7,0,96)),"disabled inputs are rejected");
  input.system("snes");input.enabled(true);input.key(new KeyEvent(7,0,KeyEvent.KEYCODE_BUTTON_Y));p=packets.get(packets.size()-1);check(p.getInt("mask")==4,"SNES Y retains its existing API bit");
  input.onInputDeviceRemoved(7);p=packets.get(packets.size()-1);check(!p.getBoolean("connected")&&p.getInt("mask")==0&&p.getJSONArray("keyMasks").length()==0,"disconnect releases all sources");input.close();
  System.out.println("PASS: production Android input with fixture events: raw/default keys, stable device identity, analog triggers, chords/releases, disable/disconnect and SNES compatibility");
 }
}
