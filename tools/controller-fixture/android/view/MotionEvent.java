package android.view;
import java.util.*;
public class MotionEvent extends InputEvent {
 public static final int ACTION_MOVE=2,AXIS_X=0,AXIS_Y=1,AXIS_HAT_X=15,AXIS_HAT_Y=16,AXIS_LTRIGGER=17,AXIS_RTRIGGER=18,AXIS_GAS=22,AXIS_BRAKE=23;
 private final Map<Integer,Float> values;
 public MotionEvent(int id,Map<Integer,Float> values){super(id,InputDevice.SOURCE_JOYSTICK);this.values=values;}
 public int getAction(){return ACTION_MOVE;}public float getAxisValue(int axis){return values.getOrDefault(axis,0f);}
}
