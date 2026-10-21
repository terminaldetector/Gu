package android.view;
import java.util.*;
public class InputDevice {
 public static final int SOURCE_GAMEPAD=0x401,SOURCE_JOYSTICK=0x1000010;
 public static final Map<Integer,InputDevice> DEVICES=new HashMap<>();
 private final String descriptor,name;private final int sources;private final boolean virtual;
 public InputDevice(String descriptor){this(descriptor,"Fixture pad",SOURCE_GAMEPAD|SOURCE_JOYSTICK,false);}
 public InputDevice(String descriptor,String name,int sources,boolean virtual){this.descriptor=descriptor;this.name=name;this.sources=sources;this.virtual=virtual;}
 public static InputDevice getDevice(int id){return DEVICES.get(id);}
 public static int[] getDeviceIds(){return DEVICES.keySet().stream().mapToInt(Integer::intValue).toArray();}
 public String getDescriptor(){return descriptor;} public String getName(){return name;}
 public int getSources(){return sources;}public boolean isVirtual(){return virtual;}
 public MotionRange getMotionRange(int axis,int source){return new MotionRange();}
 public static class MotionRange{public float getFlat(){return .05f;}}
}
