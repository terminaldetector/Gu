package android.hardware.input;
public class InputManager {
 public interface InputDeviceListener {void onInputDeviceAdded(int id);void onInputDeviceChanged(int id);void onInputDeviceRemoved(int id);}
 public void registerInputDeviceListener(InputDeviceListener listener,Object handler){}
 public void unregisterInputDeviceListener(InputDeviceListener listener){}
}
