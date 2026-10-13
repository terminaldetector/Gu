package android.view;
public class InputEvent {
 protected final int id,source;
 public InputEvent(int id,int source){this.id=id;this.source=source;}
 public int getSource(){return source;}public int getDeviceId(){return id;}public InputDevice getDevice(){return InputDevice.getDevice(id);}
}
