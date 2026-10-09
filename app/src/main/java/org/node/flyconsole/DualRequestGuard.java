package org.node.flyconsole;

/** Token order fences old observations even when a game-state boundary rewinds frame numbers. */
final class DualRequestGuard {
    private long lastSerial,lastFrame=-1;
    DualRequestGuard(Object configureToken){lastSerial=serial(configureToken);}
    static long serial(Object token){
        long value;
        if(token instanceof Number){double d=((Number)token).doubleValue();value=((Number)token).longValue();if(!Double.isFinite(d)||d!=value)throw new IllegalArgumentException("Dual token must be integer");}
        else if(token instanceof String&&((String)token).matches("dual-[0-9]{1,16}"))value=Long.parseLong(((String)token).substring(5));
        else throw new IllegalArgumentException("Dual token must be numeric or dual-N");
        if(value<0||value>9007199254740991L)throw new IllegalArgumentException("Dual token range");return value;
    }
    synchronized boolean fresh(Object token){return serial(token)>lastSerial;}
    synchronized void sample(Object token,long frame){long next=serial(token);if(next<=lastSerial||frame<=lastFrame||frame<0||frame>9007199254740991L)throw new IllegalArgumentException("Duplicate or stale dual request");lastSerial=next;lastFrame=frame;}
    synchronized void boundary(Object token){long next=serial(token);if(next<=lastSerial)throw new IllegalArgumentException("Duplicate or stale dual boundary");lastSerial=next;lastFrame=-1;}
}
