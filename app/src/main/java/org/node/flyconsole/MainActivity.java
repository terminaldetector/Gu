package org.node.flyconsole;
import android.app.*;import android.os.*;import android.content.*;import android.net.Uri;import android.graphics.Color;import android.widget.*;import java.io.*;import java.util.concurrent.*;import java.util.concurrent.atomic.AtomicBoolean;
public final class MainActivity extends Activity {
 private final ExecutorService worker=Executors.newSingleThreadExecutor();private final AtomicBoolean cancel=new AtomicBoolean();
 private Engine engine;private Graph graph;private TextView log;private EditText entry;private Button send,load;private boolean busy;private File model;
 public void onCreate(Bundle b){super.onCreate(b);getWindow().setStatusBarColor(Color.rgb(5,5,16));
  LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(20,32,20,20);root.setBackgroundColor(Color.rgb(5,5,16));
  TextView title=new TextView(this);title.setText("FLY / CONSOLE");title.setTextSize(25);title.setTextColor(Color.rgb(130,255,190));root.addView(title);
  load=new Button(this);load.setText("Импорт .fly / .fly.gz");root.addView(load);load.setOnClickListener(v->{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.setType("*/*");i.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(i,1);});
  ScrollView scroll=new ScrollView(this);log=new TextView(this);log.setTextColor(Color.LTGRAY);log.setTextSize(16);scroll.addView(log);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
  entry=new EditText(this);entry.setTextColor(Color.WHITE);entry.setHintTextColor(Color.GRAY);entry.setHint("stim ID Hz ms / status / reset");entry.setSingleLine();root.addView(entry);
  send=new Button(this);send.setText("Запустить");root.addView(send);send.setOnClickListener(v->command());Button stop=new Button(this);stop.setText("Стоп");root.addView(stop);stop.setOnClickListener(v->cancel.set(true));setContentView(root);
  model=new File(getFilesDir(),"connectome.fly");append("Локальная лаборатория импульсов. Команды не интерпретируются языковой моделью.\nЗагружается встроенный FlyWire v783. Если память не позволяет — СИНТЕТИЧЕСКИЙ тест из 4 нейронов.\nПосле загрузки используйте первый ID из отчёта.");
  graph=Graph.demo();engine=new Engine(graph);importGraph(null);
 }
 private void append(String s){log.append("\n\n"+s);}
 private void state(boolean b){busy=b;send.setEnabled(!b);load.setEnabled(!b);}
 private long budget(){return Math.max(0,Runtime.getRuntime().maxMemory()-Runtime.getRuntime().totalMemory()+Runtime.getRuntime().freeMemory())*2/3;}
 protected void onActivityResult(int r,int c,Intent data){super.onActivityResult(r,c,data);if(r==1&&c==RESULT_OK&&data!=null)importGraph(data.getData());}
 private InputStream bundledInput() throws IOException {try{return getAssets().open("brain.fly.gz");}catch(IOException ex){return getAssets().open("brain.fly");}}
 private void importGraph(Uri uri){if(busy)return;state(true);graph=null;engine=null;append("Загрузка…");worker.execute(()->{File tmp=new File(getFilesDir(),"import.tmp");try{
   if(uri!=null){try(InputStream in=getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(tmp)){byte[] buf=new byte[65536];int n;long total=0;while((n=in.read(buf))!=-1){total+=n;if(total>1024L*1024*1024)throw new IOException("Файл больше 1 ГБ");out.write(buf,0,n);}}}
   Graph loaded;try(InputStream in=uri==null?(model.exists()?new FileInputStream(model):bundledInput()):new FileInputStream(tmp)){loaded=Graph.read(in,budget());}
   Engine next=new Engine(loaded);if(uri!=null&&!tmp.renameTo(model))throw new IOException("Не удалось сохранить граф");graph=loaded;engine=next;
   runOnUiThread(()->{append("Импортирован граф: "+graph.ids.length+" нейронов / "+graph.targets.length+" связей\nПервый ID: "+graph.ids[0]+" · оценка памяти: "+graph.memoryBytes()/1048576+" МиБ");state(false);});
  }catch(Exception|OutOfMemoryError ex){tmp.delete();graph=Graph.demo();engine=new Engine(graph);runOnUiThread(()->{append("Импорт не выполнен: "+ex.getMessage()+"\nВключён синтетический тест.");state(false);});}});}
 private void command(){if(busy)return;String text=entry.getText().toString().trim();append("› "+text);String[] a=text.split("\\s+");
  try{if(text.equals("status")){ActivityManager.MemoryInfo m=new ActivityManager.MemoryInfo();((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(m);append(graph.ids.length+" нейронов · "+graph.targets.length+" связей\nRAM устройства "+m.totalMem/1048576+" МиБ; heap "+Runtime.getRuntime().maxMemory()/1048576+" МиБ\nМодель: LIF, шаг 0.1 ms; мобильная реализация, паритет Brian2 не проверен");return;}
   if(text.equals("reset")){engine.reset();append("Состояние и seed сброшены");return;}
   if(a.length!=4||!a[0].equals("stim"))throw new IllegalArgumentException("Формат: stim ID Hz ms; status; reset");
   long id=Long.parseLong(a[1]);double hz=Double.parseDouble(a[2]);int ms=Integer.parseInt(a[3]);if(!Double.isFinite(hz)||hz<0||hz>1000||ms<1||ms>10000)throw new IllegalArgumentException("Hz 0–1000; ms 1–10000");
   cancel.set(false);state(true);worker.execute(()->{try{String result=engine.run(id,hz,ms,cancel);runOnUiThread(()->{append(result);state(false);});}catch(Exception ex){runOnUiThread(()->{append(ex.getMessage());state(false);});}});
  }catch(Exception ex){append(ex.getMessage());}
 }
 protected void onDestroy(){cancel.set(true);worker.shutdown();super.onDestroy();}
}
