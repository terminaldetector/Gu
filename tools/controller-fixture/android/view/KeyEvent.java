package android.view;
public class KeyEvent extends InputEvent {
 public static final int ACTION_DOWN=0,ACTION_UP=1,KEYCODE_BACK=4,KEYCODE_DPAD_UP=19,KEYCODE_DPAD_DOWN=20,KEYCODE_DPAD_LEFT=21,KEYCODE_DPAD_RIGHT=22;
 public static final int KEYCODE_BUTTON_A=96,KEYCODE_BUTTON_B=97,KEYCODE_BUTTON_C=98,KEYCODE_BUTTON_X=99,KEYCODE_BUTTON_Y=100,KEYCODE_BUTTON_Z=101,KEYCODE_BUTTON_L1=102,KEYCODE_BUTTON_R1=103,KEYCODE_BUTTON_L2=104,KEYCODE_BUTTON_R2=105,KEYCODE_BUTTON_THUMBL=106,KEYCODE_BUTTON_THUMBR=107,KEYCODE_BUTTON_START=108,KEYCODE_BUTTON_SELECT=109,KEYCODE_BUTTON_MODE=110,KEYCODE_BUTTON_1=188,KEYCODE_BUTTON_16=203;
 private final int action,code;
 public KeyEvent(int id,int action,int code){super(id,InputDevice.SOURCE_GAMEPAD);this.action=action;this.code=code;}
 public int getKeyCode(){return code;}public int getAction(){return action;}public static String keyCodeToString(int code){return "KEYCODE_"+code;}
}
