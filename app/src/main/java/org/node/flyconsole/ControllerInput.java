package org.node.flyconsole;

import android.content.Context;
import android.hardware.input.InputManager;
import android.view.*;
import org.json.JSONObject;
import java.util.*;

/** Android buttons and joystick axes, one source mask per physical device. */
public final class ControllerInput implements InputManager.InputDeviceListener {
    public interface Sink { void send(JSONObject data); }
    private final InputManager manager;private final Sink sink;
    private final Map<Integer,Set<Integer>> keys=new HashMap<>();private final Map<Integer,Integer> axes=new HashMap<>();
    private boolean sega,snes,enabled=true;
    public ControllerInput(Context context,Sink sink){this.sink=sink;manager=(InputManager)context.getSystemService(Context.INPUT_SERVICE);manager.registerInputDeviceListener(this,null);}
    public void system(boolean value){system(value?"sega":"nes");}
    public void system(String value){clear();sega="sega".equals(value);snes="snes".equals(value);}
    public void enabled(boolean value){if(!value)clear();enabled=value;}
    private static boolean gamepad(InputEvent e){return (e.getSource()&InputDevice.SOURCE_GAMEPAD)==InputDevice.SOURCE_GAMEPAD||(e.getSource()&InputDevice.SOURCE_JOYSTICK)==InputDevice.SOURCE_JOYSTICK;}
    private int bit(int code){switch(code){
        case KeyEvent.KEYCODE_DPAD_UP:return 16;case KeyEvent.KEYCODE_DPAD_DOWN:return 32;case KeyEvent.KEYCODE_DPAD_LEFT:return 64;case KeyEvent.KEYCODE_DPAD_RIGHT:return 128;
        case KeyEvent.KEYCODE_BUTTON_A:return 1;case KeyEvent.KEYCODE_BUTTON_B:return 2;case KeyEvent.KEYCODE_BUTTON_C:return sega?4:0;
        case KeyEvent.KEYCODE_BUTTON_X:return snes||sega?256:1;case KeyEvent.KEYCODE_BUTTON_Y:return snes?4:sega?512:2;case KeyEvent.KEYCODE_BUTTON_Z:return sega?1024:0;
        case KeyEvent.KEYCODE_BUTTON_L1:return snes?512:sega?4:0;case KeyEvent.KEYCODE_BUTTON_R1:return snes||sega?1024:0;
        case KeyEvent.KEYCODE_BUTTON_START:return 8;case KeyEvent.KEYCODE_BUTTON_SELECT:return snes||sega?2048:4;default:return 0;
    }}
    public boolean key(KeyEvent e){if(!enabled||!gamepad(e))return false;int bit=bit(e.getKeyCode());if(bit==0)return false;
        int id=e.getDeviceId();Set<Integer> held=keys.computeIfAbsent(id,k->new HashSet<>());
        if(e.getAction()==KeyEvent.ACTION_DOWN)held.add(e.getKeyCode());else if(e.getAction()==KeyEvent.ACTION_UP)held.remove(e.getKeyCode());else return false;
        send(id,true);return true;
    }
    private int keyMask(int id){int mask=0;for(int code:keys.getOrDefault(id,Collections.emptySet()))mask|=bit(code);return mask;}
    private static float centered(MotionEvent e,int axis){InputDevice d=e.getDevice();InputDevice.MotionRange r=d==null?null:d.getMotionRange(axis,e.getSource());float value=e.getAxisValue(axis);return Math.abs(value)<=Math.max(.25f,r==null?0:r.getFlat())?0:value;}
    public boolean motion(MotionEvent e){if(!enabled||!gamepad(e)||e.getAction()!=MotionEvent.ACTION_MOVE)return false;
        float x=centered(e,MotionEvent.AXIS_X),y=centered(e,MotionEvent.AXIS_Y),hx=centered(e,MotionEvent.AXIS_HAT_X),hy=centered(e,MotionEvent.AXIS_HAT_Y);
        if(hx!=0)x=hx;if(hy!=0)y=hy;int mask=(y<0?16:y>0?32:0)|(x<0?64:x>0?128:0);
        axes.put(e.getDeviceId(),mask);send(e.getDeviceId(),true);return true;
    }
    private void send(int id,boolean connected){try{InputDevice d=InputDevice.getDevice(id);sink.send(new JSONObject().put("id",id).put("name",d==null?"Controller "+id:d.getName()).put("mask",keyMask(id)|axes.getOrDefault(id,0)).put("connected",connected));}catch(Exception ignored){}}
    public void clear(){Set<Integer> ids=new HashSet<>(keys.keySet());ids.addAll(axes.keySet());keys.clear();axes.clear();for(int id:ids)send(id,true);}
    public void close(){clear();manager.unregisterInputDeviceListener(this);}
    public void onInputDeviceAdded(int id){}public void onInputDeviceChanged(int id){onInputDeviceRemoved(id);}public void onInputDeviceRemoved(int id){keys.remove(id);axes.remove(id);send(id,false);}
}
