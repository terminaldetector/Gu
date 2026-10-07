package org.node.flyconsole;

import java.util.Arrays;
import java.util.Random;

/** Technical ports: not an anatomical sensory/motor classification. */
public final class Experiment {
    public static final String[] BUTTONS = {"A", "B", "Select", "Start", "Up", "Down", "Left", "Right"};
    public final int[] inputs, outputs;
    public final int[] permutation = new int[16];
    public final Engine.Options options = new Engine.Options();
    public String mode = "observe";
    public boolean scramble;
    public int windowMs = 20;
    public double maxHz = 150, thresholdHz = 30;
    public long seed = 1;

    public Experiment(int[] inputs, int[] outputs) {
        if (inputs.length != 16 || outputs.length != 8) throw new IllegalArgumentException("Нужно 16 входов и 8 выходов");
        this.inputs = inputs.clone();
        this.outputs = outputs.clone();
        seedPermutation(1);
    }

    public void seedPermutation(long seed) {
        this.seed = seed;
        for (int i = 0; i < 16; i++) permutation[i] = i;
        Random random = new Random(seed);
        for (int i = 15; i > 0; i--) {
            int j = random.nextInt(i + 1), temp = permutation[i];
            permutation[i] = permutation[j];
            permutation[j] = temp;
        }
    }

    public double[] rates(double[] brightness) {
        if (brightness.length != 16) throw new IllegalArgumentException("Нужно 16 измерений экрана");
        double[] rates = new double[16];
        for (int i = 0; i < 16; i++) {
            double value = brightness[scramble ? permutation[i] : i];
            if (!Double.isFinite(value) || value < 0 || value > 1) throw new IllegalArgumentException("Яркость должна быть 0–1");
            rates[i] = mode.equals("sham") ? 0 : value * maxHz;
        }
        return rates;
    }

    public int buttons(Engine.Result result) {
        if (!mode.equals("closed") || result.steps == 0) return 0;
        int mask = 0;
        for (int i = 0; i < outputs.length; i++) {
            double hz = result.counts[outputs[i]] * 10000.0 / result.steps;
            if (hz >= thresholdHz && result.counts[outputs[i]] > 0) mask |= 1 << i;
        }
        // Opposing directions cancel. A/B/Start/Select remain independent.
        if ((mask & 48) == 48) mask &= ~48;
        if ((mask & 192) == 192) mask &= ~192;
        return mask;
    }

    public static Experiment automatic(Graph graph) {
        if (graph.ids.length < 24) throw new IllegalArgumentException("Для NES нужны хотя бы 24 нейрона");
        int[] inputs = new int[16];
        Arrays.fill(inputs, -1);
        for (int i = 0; i < graph.ids.length; i++) {
            int degree = graph.offsets[i + 1] - graph.offsets[i];
            for (int slot = 0; slot < 16; slot++) {
                if (inputs[slot] < 0 || degree > graph.offsets[inputs[slot] + 1] - graph.offsets[inputs[slot]]) {
                    for (int k = 15; k > slot; k--) inputs[k] = inputs[k - 1];
                    inputs[slot] = i;
                    break;
                }
            }
        }
        int[] outputs = new int[8];
        Arrays.fill(outputs, -1);
        // Strong positive postsynaptic targets of the selected inputs, without overlap.
        for (int slot = 0; slot < 8; slot++) {
            float best = 0;
            int candidate = -1;
            for (int input : inputs) for (int edge = graph.offsets[input]; edge < graph.offsets[input + 1]; edge++) {
                int target = graph.targets[edge];
                if (contains(inputs, target) || contains(outputs, target)) continue;
                if (graph.weights[edge] > best) { best = graph.weights[edge]; candidate = target; }
            }
            if (candidate < 0) for (int i = 0; i < graph.ids.length; i++) {
                if (!contains(inputs, i) && !contains(outputs, i)) { candidate = i; break; }
            }
            outputs[slot] = candidate;
        }
        return new Experiment(inputs, outputs);
    }

    private static boolean contains(int[] values, int value) {
        for (int i : values) if (i == value) return true;
        return false;
    }
}
