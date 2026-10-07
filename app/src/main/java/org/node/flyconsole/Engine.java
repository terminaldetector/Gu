package org.node.flyconsole;

import java.util.Arrays;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

/** Independent 0.1 ms LIF engine. Experimental interventions are explicit. */
public final class Engine {
    private final Graph graph;
    private final double[] voltage, current;
    private final int[] refractory;
    private final float[][] pending;
    private Random random;
    private long tick;
    private static final double EV = Math.exp(-.1 / 20);
    private static final double EG = Math.exp(-.1 / 5);
    private static final double COUPLING = (EV - EG) / 3;

    public static final class Options {
        public double gain = 1;
        public boolean disableInhibition;
        public int[] lesions = new int[0];
        /** Optional FDB plastic/growth layer; the immutable CSR stays untouched. */
        public GraphDelta delta;
    }

    public static final class Result {
        public final int[] counts;
        public final long spikes, endTick;
        public final int active, steps;
        public final double wallSeconds;
        Result(int[] counts, long spikes, long endTick, int steps, double wallSeconds) {
            this.counts = counts;
            this.spikes = spikes;
            this.endTick = endTick;
            this.steps = steps;
            this.wallSeconds = wallSeconds;
            int n = 0;
            for (int c : counts) if (c > 0) n++;
            active = n;
        }
    }

    public Engine(Graph graph) {
        this.graph = graph;
        int n = graph.ids.length;
        voltage = new double[n];
        current = new double[n];
        refractory = new int[n];
        pending = new float[19][n];
        reset(1);
    }

    public void reset() { reset(1); }
    public void reset(long seed) {
        Arrays.fill(voltage, -52);
        Arrays.fill(current, 0);
        Arrays.fill(refractory, 0);
        for (float[] a : pending) Arrays.fill(a, 0);
        tick = 0;
        random = new Random(seed);
    }

    public int index(long id) {
        int index = Arrays.binarySearch(graph.ids, id);
        if (index < 0) throw new IllegalArgumentException("Неизвестный FlyWire ID: " + id);
        return index;
    }

    public Result advance(int[] inputs, double[] rates, int durationMs,
                          Options options, AtomicBoolean cancel) {
        if (inputs.length != rates.length || inputs.length > 256 || durationMs < 1 || durationMs > 10000)
            throw new IllegalArgumentException("Неверные параметры симуляции");
        if (!Double.isFinite(options.gain) || options.gain < 0 || options.gain > 2)
            throw new IllegalArgumentException("Усиление должно быть 0–2");
        boolean[] driven = new boolean[voltage.length];
        boolean[] lesioned = new boolean[voltage.length];
        double[] probability = new double[inputs.length];
        for (int k = 0; k < inputs.length; k++) {
            if (inputs[k] < 0 || inputs[k] >= voltage.length || !Double.isFinite(rates[k]) || rates[k] < 0 || rates[k] > 1000)
                throw new IllegalArgumentException("Неверный вход");
            if (driven[inputs[k]]) throw new IllegalArgumentException("Повторяющийся вход");
            driven[inputs[k]] = true;
            probability[k] = 1 - Math.exp(-rates[k] * .0001);
        }
        for (int i : options.lesions) {
            if (i < 0 || i >= voltage.length) throw new IllegalArgumentException("Неверная абляция");
            lesioned[i] = true;
            voltage[i] = -52;
            current[i] = 0;
        }
        long start = System.nanoTime(), spikes = 0;
        int[] counts = new int[voltage.length];
        int steps = durationMs * 10, done = 0;
        for (; done < steps && !cancel.get(); done++, tick++) {
            float[] due = pending[(int) (tick % 19)];
            for (int i = 0; i < voltage.length; i++) {
                if (lesioned[i]) { due[i] = 0; continue; }
                current[i] += due[i];
                due[i] = 0;
                if (refractory[i] > 0) { refractory[i]--; continue; }
                voltage[i] = -52 + (voltage[i] + 52) * EV + current[i] * COUPLING;
                current[i] *= EG;
            }
            for (int k = 0; k < inputs.length; k++) {
                if (!lesioned[inputs[k]] && random.nextDouble() < probability[k])
                    voltage[inputs[k]] += .275 * 250;
            }
            for (int i = 0; i < voltage.length; i++) {
                if (lesioned[i] || voltage[i] <= -45) continue;
                counts[i]++;
                spikes++;
                voltage[i] = -52;
                current[i] = 0;
                refractory[i] = driven[i] ? 0 : 22;
                float[] future = pending[(int) ((tick + 18) % 19)];
                for (int edge = graph.offsets[i]; edge < graph.offsets[i + 1]; edge++) {
                    int target = graph.targets[edge];
                    if (lesioned[target]) continue;
                    float weight = graph.weights[edge] + (options.delta == null ? 0 : options.delta.weightDelta(i, target));
                    if (lesioned[target] || (options.disableInhibition && weight < 0)) continue;
                    future[target] += weight * options.gain;
                }
                if (options.delta != null) for (GraphDelta.Edge extra : options.delta.outgoing(i)) {
                    if (lesioned[extra.target] || (options.disableInhibition && extra.weight < 0)) continue;
                    future[extra.target] += extra.weight * options.gain;
                }
            }
        }
        return new Result(counts, spikes, tick, done, (System.nanoTime() - start) / 1e9);
    }

    public String run(long id, double hz, int durationMs, AtomicBoolean cancel) {
        Result result = advance(new int[]{index(id)}, new double[]{hz}, durationMs, new Options(), cancel);
        StringBuilder out = new StringBuilder(String.format(Locale.US,
            "%s %.1f ms · %.3f s на CPU · ×%.2f\n%d импульсов · %d активных нейронов",
            cancel.get() ? "Остановлено" : "Завершено", result.steps * .1, result.wallSeconds,
            result.steps * .0001 / Math.max(result.wallSeconds, 1e-9), result.spikes, result.active));
        int[] counts = result.counts.clone();
        for (int k = 0; k < Math.min(8, counts.length); k++) {
            int best = 0;
            for (int i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
            if (counts[best] == 0) break;
            out.append("\n").append(graph.ids[best]).append(": ").append(counts[best]);
            counts[best] = 0;
        }
        return out.toString();
    }
}
