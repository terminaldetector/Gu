package org.node.flyconsole;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Bundled offline OCR, used only to discover a score, never for delayed neural credit. */
final class ScoreOcr implements AutoCloseable {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy=new AtomicBoolean();
    private TextRecognizer recognizer;
    void recognize(String raw,Consumer<JSONObject> done) {
        final String requestToken;
        try{if(raw.length()>2*1024*1024)throw new IllegalArgumentException("Изображение счёта слишком велико");requestToken=new JSONObject(raw).getString("token");if(!requestToken.matches("score-[0-9]+"))throw new IllegalArgumentException("Неверный запрос счёта");}
        catch(Exception ex){reply(done,"",null,ex.getMessage());return;}
        if(!busy.compareAndSet(false,true)){reply(done,requestToken,null,"Поиск уже выполняется");return;}
        if(worker.isShutdown()){busy.set(false);reply(done,requestToken,null,"Поиск закрыт");return;}
        worker.execute(()->{
            String token=requestToken;Bitmap original=null;
            try {
                if(raw.length()>2*1024*1024)throw new IllegalArgumentException("Изображение счёта слишком велико");
                JSONObject q=new JSONObject(raw);token=q.getString("token");if(!token.matches("score-[0-9]+"))throw new IllegalArgumentException("Неверный запрос счёта");
                byte[] bytes=Base64.decode(q.getString("image"),Base64.DEFAULT);
                BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
                if(bounds.outWidth<1||bounds.outWidth>640||bounds.outHeight<1||bounds.outHeight>512)throw new IllegalArgumentException("Неверный размер игрового кадра");
                original=BitmapFactory.decodeByteArray(bytes,0,bytes.length);if(original==null)throw new IllegalArgumentException("Кадр не прочитан");
                int w=original.getWidth(),h=original.getHeight();final Bitmap image=Bitmap.createScaledBitmap(original,w*3,h*3,false);
                if(recognizer==null)recognizer=TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                Task<Text> task=recognizer.process(InputImage.fromBitmap(image,0));task.addOnCompleteListener(t->image.recycle());
                Text text=Tasks.await(task,15,TimeUnit.SECONDS);JSONArray found=new JSONArray();
                for(Text.TextBlock block:text.getTextBlocks())for(Text.Line line:block.getLines())for(Text.Element element:line.getElements()) {
                    String number=element.getText().trim();if(!number.matches("[0-9][0-9,.]{1,10}[0-9]"))continue;
                    String digits=number.replaceAll("[^0-9]","");if(digits.length()>9)continue;
                    Rect r=element.getBoundingBox();if(r==null||found.length()>=48)continue;
                    int x=Math.max(0,r.left/3),y=Math.max(0,r.top/3),right=Math.min(w,(r.right+2)/3),bottom=Math.min(h,(r.bottom+2)/3);
                    if(right<=x||bottom<=y)continue;
                    found.put(new JSONObject().put("digits",digits).put("label",line.getText()).put("rect",new JSONArray().put(x).put(y).put(right-x).put(bottom-y)));
                }
                reply(done,token,found,null);
            } catch(Exception ex){reply(done,token,null,ex.getMessage()==null?"Счёт не распознан":ex.getMessage());}
            finally{if(original!=null)original.recycle();busy.set(false);}
        });
    }
    private static void reply(Consumer<JSONObject> done,String token,JSONArray found,String error){
        try{JSONObject result=new JSONObject().put("token",token);if(error!=null)result.put("error",error);else result.put("candidates",found);done.accept(result);}catch(Exception ignored){}
    }
    @Override public void close(){worker.shutdownNow();if(recognizer!=null)recognizer.close();}
}
