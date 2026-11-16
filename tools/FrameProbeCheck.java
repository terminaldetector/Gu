package org.node.flyconsole;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;

/** The fast-loop probe's native controller: header parsing, the same feature as the
    in-WebView worker (reference motions below come from lab/fast-loop-worker.js on the
    same generated frames), and refusal of malformed frames. */
public final class FrameProbeCheck {
    static final int W = 256, H = 240;
    /* lab/fast-loop-worker.js on frames(k) for k=0..3 (Float32 luminance, as in Java) */
    static final double[] WORKER_MOTION = {0, 7.31342499901851, 12.673322506248951, 8.640050057073434};
    static final int[] WORKER_MASK = {128, 129, 129, 129};

    static int[] frame(int k) {
        int[] px = new int[W * H];
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++)
            px[y * W + x] = ((x * 7 + y * 3 + k * 11) & 255) | (((x + k * 5) & 255) << 8) | (((y * 5 + k) & 255) << 16);
        return px;
    }

    static byte[] pixels(int[] px) {
        ByteBuffer b = ByteBuffer.allocate(px.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int c : px) b.putInt(c);
        return b.array();
    }

    static byte[] message(int width, int height, int frameIndex, int epoch, int seq, byte[] pixels) {
        ByteBuffer b = ByteBuffer.allocate(FrameProbe.HEADER_BYTES + pixels.length).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(width).putInt(height).putInt(frameIndex).putInt(epoch).putInt(seq).putInt(0).put(pixels);
        return b.array();
    }

    static double number(String json, String key) {
        int at = json.indexOf("\"" + key + "\":");
        if (at < 0) throw new AssertionError("no " + key + " in " + json);
        int from = at + key.length() + 3, to = from;
        while (to < json.length() && "-+.0123456789eE".indexOf(json.charAt(to)) >= 0) to++;
        return Double.parseDouble(json.substring(from, to));
    }

    static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }

    static void refuses(Runnable r, String what) {
        try { r.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("accepted " + what);
    }

    public static void main(String[] args) {
        /* message transport: header fields are echoed, the feature matches the worker */
        FrameProbe message = new FrameProbe(), bridge = new FrameProbe();
        for (int k = 0; k < 4; k++) {
            byte[] px = pixels(frame(k));
            String m = message.decideMessage(message(W, H, 1000 + k, 7, 40 + k, px));
            String b = bridge.decidePixels(Base64.getDecoder().decode(Base64.getEncoder().encodeToString(px)), W, H, 1000 + k, 7, 40 + k);
            check(number(m, "frameIndex") == 1000 + k && number(m, "epoch") == 7 && number(m, "seq") == 40 + k, "header echoed: " + m);
            check(Math.abs(number(m, "motion") - WORKER_MOTION[k]) < 1e-3, "frame " + k + " motion " + number(m, "motion") + " vs worker " + WORKER_MOTION[k]);
            check(number(m, "mask") == WORKER_MASK[k], "frame " + k + " mask " + m);
            check(number(m, "motion") == number(b, "motion") && number(m, "mask") == number(b, "mask"), "the bridge and message transports do the same work");
            check(number(m, "visualMs") >= 0 && number(m, "decisionMs") >= 0 && number(m, "nativeMs") >= number(m, "visualMs"), "stage times: " + m);
        }
        check(message.calls() == 4 && message.busyMs() >= 0, "calls and busy time are counted");
        /* a still screen holds the stand-in policy at Right only */
        FrameProbe still = new FrameProbe();
        byte[] same = pixels(frame(3));
        still.decidePixels(same, W, H, 0, 0, 0);
        String s = still.decidePixels(same, W, H, 1, 0, 1);
        check(number(s, "motion") == 0 && number(s, "mask") == 128, "no motion, no A: " + s);
        /* reset forgets the previous frame across a boundary */
        still.reset();
        check(number(still.decidePixels(pixels(frame(0)), W, H, 2, 1, 2), "motion") == 0, "after reset there is no previous frame");
        /* malformed frames are refused, not decided */
        FrameProbe p = new FrameProbe();
        refuses(() -> p.decideMessage(new byte[10]), "a message shorter than the header");
        refuses(() -> p.decideMessage(null), "a null message");
        refuses(() -> p.decideMessage(message(W, H, 0, 0, 0, new byte[W * H * 4 - 4])), "a message with fewer pixels than its header says");
        refuses(() -> p.decideMessage(message(0, H, 0, 0, 0, new byte[0])), "a zero-width frame");
        refuses(() -> p.decideMessage(message(2048, 1024, 0, 0, 0, new byte[0])), "a frame over the pixel cap");
        refuses(() -> p.decidePixels(new byte[8], 4, 4, 0, 0, 0), "bridge pixels shorter than the size");
        check(p.calls() == 0, "a refused frame is not counted as a decision");
        System.out.println("PASS: FrameProbe parses the 24-byte LE header, matches the in-WebView worker feature on the same frames, bridge and message paths agree, still screen gives Right only, reset forgets the previous frame, malformed frames are refused");
    }
}
