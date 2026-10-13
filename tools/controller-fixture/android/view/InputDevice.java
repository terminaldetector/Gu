package android.view;
import java.util.*;
public class InputDevice {
 public static final int SOURCE_GAMEPAD=0x401,SOURCE_JOYSTICK=0x1000010;
 public static final Map<Integer,InputDevice> DEVICES=new HashMap<>();
 private final String descriptor;
 public InputDevice(String descriptor){this.descriptor=descriptor;}
 public static InputDevice getDevice(int id){return DEVICES.get(id);}
 public static int[] getDeviceIds(){return DEVICES.keySet().stream().mapToInt(Integer::intValue).toArray();}
 public String getDescriptor(){return descriptor;} public String getName(){return "Fixture pad";}
 public int getSources(){return SOURCE_GAMEPAD|SOURCE_JOYSTICK;}
 public MotionRange getMotionRange(int axis,int source){return new MotionRange();}
 public static class MotionRange{public float getFlat(){return .05f;}}
}
