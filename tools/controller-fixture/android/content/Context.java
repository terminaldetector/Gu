package android.content;
import android.hardware.input.InputManager;
public class Context { public static final String INPUT_SERVICE="input"; public final InputManager inputs=new InputManager(); public Object getSystemService(String name){return inputs;} }
