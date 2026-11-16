package org.node.flyconsole;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** The fast-loop probe's native controller: the same stand-in work as
    lab/fast-loop-worker.js (32x30 luminance, mean absolute difference to the
    previous frame, Right plus A when the screen moves), so a native transport is
    compared with the in-WebView worker on equal work. It MEASURES THE LOOP; it is
    not a player.

    A message frame is a 24-byte little-endian header - width, height, frameIndex,
    epoch, seq, reserved (int32 each) - followed by width*height little-endian uint32
    pixels, R in the low byte (the FrameSource format rgbx8888-u32le). */
final class FrameProbe {
    static final int HEADER_BYTES = 24, W = 32, H = 30, MAX_PIXELS = 1024 * 1024;
    private float[] previous;
    private long calls;
    private double busyMs;

    /** decides from a whole message (header + pixels) */
    synchronized String decideMessage(byte[] message) {
        if (message == null || message.length < HEADER_BYTES) throw new IllegalArgumentException("frame message too short");
        ByteBuffer b = ByteBuffer.wrap(message).order(ByteOrder.LITTLE_ENDIAN);
        int width = b.getInt(0), height = b.getInt(4), frameIndex = b.getInt(8), epoch = b.getInt(12), seq = b.getInt(16);
        return decide(b, HEADER_BYTES, width, height, frameIndex, epoch, seq);
    }

    /** decides from pixels only (the base64 bridge transport passes the header as arguments) */
    synchronized String decidePixels(byte[] pixels, int width, int height, long frameIndex, long epoch, long seq) {
        return decide(ByteBuffer.wrap(pixels).order(ByteOrder.LITTLE_ENDIAN), 0, width, height, frameIndex, epoch, seq);
    }

    private String decide(ByteBuffer b, int offset, int width, int height, long frameIndex, long epoch, long seq) {
        long began = System.nanoTime();
        if (width < 1 || height < 1 || (long) width * height > MAX_PIXELS) throw new IllegalArgumentException("frame size " + width + "x" + height);
        if (b.capacity() - offset < (long) width * height * 4) throw new IllegalArgumentException("frame shorter than " + width + "x" + height);
        float[] lum = new float[W * H];
        for (int y = 0; y < H; y++) {
            int row = (int) ((long) y * height / H) * width;
            for (int x = 0; x < W; x++) {
                int c = b.getInt(offset + 4 * (row + (int) ((long) x * width / W)));
                lum[y * W + x] = (c & 255) * .2126f + ((c >>> 8) & 255) * .7152f + ((c >>> 16) & 255) * .0722f;
            }
        }
        double motion = 0;
        if (previous != null) for (int i = 0; i < lum.length; i++) motion += Math.abs(lum[i] - previous[i]);
        previous = lum;
        motion /= lum.length;
        long visual = System.nanoTime();
        int mask = motion > 2 ? 129 : 128;
        long decided = System.nanoTime();
        double ms = (decided - began) / 1e6;
        calls++;
        busyMs += ms;
        return "{\"mask\":" + mask + ",\"frameIndex\":" + frameIndex + ",\"epoch\":" + epoch + ",\"seq\":" + seq
            + ",\"motion\":" + (float) motion + ",\"visualMs\":" + (float) ((visual - began) / 1e6)
            + ",\"decisionMs\":" + (float) ((decided - visual) / 1e6) + ",\"nativeMs\":" + (float) ms + "}";
    }

    synchronized void reset() { previous = null; }
    synchronized long calls() { return calls; }
    synchronized double busyMs() { return busyMs; }
}
