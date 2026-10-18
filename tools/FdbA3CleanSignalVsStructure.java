package org.node.flyconsole;

import org.json.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Research Package A3 (Sol's review of A2, 2026-10-18): the clean version of the
 * signal-vs-structure comparison. A2's "direct" bias was contrastive (boosts the
 * correct output AND suppresses the competing one), while the relay only adds to the
 * correct output -- so A2 did not isolate structure from amplitude. A3 adds a purely
 * additive direct condition (matches the relay's own bias shape) and calibrates all
 * conditions against the relay using the SAME seed range (A2 used disjoint ranges for
 * relay vs direct calibration, flagged by Sol), then measures both output channels
 * under both cues for every condition so the match quality is shown, not asserted.
 *
 * Does not modify FdbA2SignalVsStructure.java, FdbFunctionalLearningBenchmark.java,
 * FdbTemporalExperiment.java or any production file. Section 0 cross-checks this
 * file's duplicated episode logic against A2's own committed relay rows (identical
 * graph, identical training logic) before any new number is trusted.
 */
public final class FdbA3CleanSignalVsStructure {
    static final int[] INPUTS = range(0, 16), OUTPUTS = range(16, 12);
    static final String[] TASKS = {"immediate", "sequence", "hold", "delay5", "delay10", "reversal"};
    static final long[] SEEDS = {11, 23, 37, 53, 71, 89, 101, 127, 149, 163, 179, 197, 211, 229, 241, 263, 281, 307, 331, 349};
    static final long CALIBRATION_SEED_BASE = 1000; // same base used for every condition's calibration measurement
    static final int CALIBRATION_TRIALS = 200;

    static int[] range(int start, int count) { int[] a = new int[count]; for (int i = 0; i < count; i++) a[i] = start + i; return a; }

    static Graph build(int n, int[][] edges) {
        int m = edges.length;
        int[] off = new int[n + 1], degree = new int[n], targets = new int[m];
        float[] weights = new float[m];
        for (int[] e : edges) degree[e[0]]++;
        for (int i = 0; i < n; i++) off[i + 1] = off[i] + degree[i];
        int[] cursor = off.clone();
        for (int[] e : edges) { int pos = cursor[e[0]]++; targets[pos] = e[1]; weights[pos] = e[2]; }
        long[] ids = new long[n];
        for (int i = 0; i < n; i++) ids[i] = 9007199254740993L + i;
        return new Graph(ids, off, targets, weights);
    }

    static final int[][] CORE_EDGES = {{0, 16, 20}, {0, 17, 20}, {1, 16, 20}, {1, 17, 20}, {2, 18, 20}};
    static final int[][] RELAY_EXTRA_EDGES = {{0, 30, 20}, {30, 16, 20}, {1, 31, 20}, {31, 17, 20}};
    static Graph originalGraph() { return build(90, CORE_EDGES); }
    static Graph relayGraph() {
        int[][] edges = new int[CORE_EDGES.length + RELAY_EXTRA_EDGES.length][];
        System.arraycopy(CORE_EDGES, 0, edges, 0, CORE_EDGES.length);
        System.arraycopy(RELAY_EXTRA_EDGES, 0, edges, CORE_EDGES.length, RELAY_EXTRA_EDGES.length);
        return build(90, edges);
    }

    static void applyBias(GraphDelta delta, String kind, float deltaW) {
        if (kind.equals("additive")) { delta.addWeightDelta(0, 16, deltaW); delta.addWeightDelta(1, 17, deltaW); }
        else if (kind.equals("contrastive")) { delta.addWeightDelta(0, 16, deltaW); delta.addWeightDelta(0, 17, -deltaW); delta.addWeightDelta(1, 16, -deltaW); delta.addWeightDelta(1, 17, deltaW); }
        else if (!kind.equals("none")) throw new IllegalArgumentException("bias kind");
    }

    static double measureHz(Graph graph, String biasKind, double deltaW, int output, int cue, int trials, long seedBase) {
        double sum = 0;
        for (int t = 0; t < trials; t++) {
            GraphDelta delta = new GraphDelta(graph.ids.length);
            applyBias(delta, biasKind, (float) deltaW);
            Engine engine = new Engine(graph);
            engine.reset(seedBase + t);
            Engine.Options opt = new Engine.Options(); opt.delta = delta;
            double[] rates = new double[16]; rates[cue] = 500;
            Engine.Result r = engine.advance(INPUTS, rates, 30, opt, new AtomicBoolean());
            sum += r.counts[output] * 10000.0 / r.steps;
        }
        return sum / trials;
    }

    static double calibrate(Graph graph, String biasKind, double targetHz16cue0) {
        double lo = 0, hi = 30, best = 0, bestHz = measureHz(graph, biasKind, 0, 16, 0, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
        for (int i = 0; i < 24; i++) {
            double mid = (lo + hi) / 2;
            double hz = measureHz(graph, biasKind, mid, 16, 0, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
            if (Math.abs(hz - targetHz16cue0) < Math.abs(bestHz - targetHz16cue0)) { best = mid; bestHz = hz; }
            if (hz < targetHz16cue0) lo = mid; else hi = mid;
        }
        return best;
    }

    static final class Run {
        final GraphDelta delta; final FdbLearning learner; final Engine engine;
        final Engine.Options options = new Engine.Options(); int decision; final long seed;
        Run(Graph graph, long seed, String biasKind, double deltaW) {
            this.seed = seed;
            delta = new GraphDelta(graph.ids.length, 2048);
            applyBias(delta, biasKind, (float) deltaW);
            engine = new Engine(graph);
            learner = new FdbLearning(graph, delta, INPUTS, OUTPUTS, .1, 2048, 127, true, "expanded");
            learner.seed(seed);
            options.delta = delta;
        }
        FdbLearning.Decision decide(int cue, boolean train, boolean distract, double rate) {
            double[] rates = new double[16]; rates[cue] = rate;
            Engine.Result r = engine.advance(INPUTS, rates, 30, options, new AtomicBoolean());
            return learner.decide("t" + (decision++), r, distract ? new int[]{0, 4} : new int[]{1, 2}, 4095, 100, train ? .1 : 0, train, null);
        }
        void feedback(FdbLearning.Decision d, double r, boolean train) { if (train) learner.feedback(d.id, d.mask, r, .5, 30, true, false, null); }
        boolean episode(String task, int episode, boolean train, boolean heldout) {
            learner.boundary(); engine.reset(seed * 1009 + episode + (heldout ? 100000 : 0));
            int cue = episode % 2; double hz = heldout ? 450 : 500;
            boolean reverse = task.equals("reversal") && (heldout || episode >= 40);
            int expected = (cue ^ (reverse ? 1 : 0)) == 0 ? 1 : 2;
            FdbLearning.Decision first = decide(cue, train, false, hz); boolean ok = first.mask == expected;
            int delay = task.equals("delay10") ? 10 : task.equals("delay5") ? 5 : 0;
            if (delay > 0) { feedback(first, 0, train); for (int i = 1; i <= delay; i++) { FdbLearning.Decision filler = decide(2, train, true, hz); feedback(filler, i == delay ? (ok ? 1 : -1) : 0, train); } }
            else if (task.equals("sequence") || task.equals("hold")) { feedback(first, 0, train); for (int i = 1; i < 3; i++) { int next = task.equals("sequence") ? (cue + i) % 2 : cue; FdbLearning.Decision d = decide(next, train, false, hz); ok &= d.mask == (next == 0 ? 1 : 2); feedback(d, i == 2 ? (ok ? 1 : -1) : 0, train); } }
            else feedback(first, ok ? 1 : -1, train);
            return ok;
        }
    }

    static double heldoutSuccess(Graph graph, long seed, String task, String biasKind, double deltaW, boolean train) {
        Run r = new Run(graph, seed, biasKind, deltaW);
        for (int e = 0; e < 80; e++) r.episode(task, e, train, false);
        r.learner.boundary();
        int held = 0;
        for (int e = 0; e < 40; e++) held += r.episode(task, e, false, true) ? 1 : 0;
        return held / 40.0;
    }

    static double[] bootstrapCi(double[] perSeed, long rngSeed, int b) {
        Random rng = new Random(rngSeed); double[] means = new double[b]; int n = perSeed.length;
        for (int i = 0; i < b; i++) { double sum = 0; for (int j = 0; j < n; j++) sum += perSeed[rng.nextInt(n)]; means[i] = sum / n; }
        Arrays.sort(means);
        double mean = 0; for (double v : perSeed) mean += v; mean /= n;
        return new double[]{mean, means[(int) (b * .025)], means[(int) (b * .975) - 1]};
    }

    public static void main(String[] args) throws Exception {
        // --- Section 0: cross-check against A2's own committed relay/single-v1 rows (identical graph, identical training). ---
        JSONObject a2 = new JSONObject(new String(Files.readAllBytes(Paths.get("docs/reports/research-fdb-growth-audit-2026-10-18/a2-signal-vs-structure.json")), StandardCharsets.UTF_8));
        Map<String, Double> a2Rows = new HashMap<>();
        for (int i = 0; i < a2.getJSONArray("rows").length(); i++) {
            JSONObject row = a2.getJSONArray("rows").getJSONObject(i);
            if (row.getString("condition").equals("relay") && row.getBoolean("trained"))
                a2Rows.put(row.getString("task") + ":" + row.getInt("seed"), row.getDouble("heldoutSuccess"));
        }
        Graph relay = relayGraph(), original = originalGraph();
        int mismatches = 0;
        for (String task : TASKS) for (long seed : SEEDS) {
            Double expected = a2Rows.get(task + ":" + seed);
            if (expected == null) continue;
            double actual = heldoutSuccess(relay, seed, task, "none", 0, true);
            if (!expected.equals(actual)) mismatches++;
        }
        System.out.println(mismatches == 0
            ? "CONFIRMED: this tool reproduces all " + a2Rows.size() + " of A2's committed relay/trained rows exactly."
            : "MISMATCH: " + mismatches + " rows diverge from A2 -- do not trust Section 1-2.");
        if (mismatches != 0) throw new AssertionError("Episode logic diverged from FdbA2SignalVsStructure/A2.");

        // --- Calibration: same seed base for every measurement (fixes A2's disjoint-seed-range gap). ---
        double relayHz16cue0 = measureHz(relay, "none", 0, 16, 0, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
        double additiveDeltaW = calibrate(original, "additive", relayHz16cue0);
        double contrastiveDeltaW = calibrate(original, "contrastive", relayHz16cue0);

        // Full 2x2 Hz table (both outputs, both cues) for every condition at the same seed base -- shows the match, doesn't assert it.
        String[] conditionNames = {"original", "direct-additive", "direct-contrastive", "relay"};
        Graph[] conditionGraphs = {original, original, original, relay};
        String[] conditionBias = {"none", "additive", "contrastive", "none"};
        double[] conditionDeltaW = {0, additiveDeltaW, contrastiveDeltaW, 0};
        JSONArray hzTable = new JSONArray();
        for (int c = 0; c < conditionNames.length; c++) {
            double hz16cue0 = measureHz(conditionGraphs[c], conditionBias[c], conditionDeltaW[c], 16, 0, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
            double hz17cue0 = measureHz(conditionGraphs[c], conditionBias[c], conditionDeltaW[c], 17, 0, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
            double hz16cue1 = measureHz(conditionGraphs[c], conditionBias[c], conditionDeltaW[c], 16, 1, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
            double hz17cue1 = measureHz(conditionGraphs[c], conditionBias[c], conditionDeltaW[c], 17, 1, CALIBRATION_TRIALS, CALIBRATION_SEED_BASE);
            hzTable.put(new JSONObject().put("condition", conditionNames[c]).put("deltaW", conditionDeltaW[c])
                .put("output16Hz_cue0_correct", hz16cue0).put("output17Hz_cue0_competing", hz17cue0)
                .put("output17Hz_cue1_correct", hz17cue1).put("output16Hz_cue1_competing", hz16cue1));
        }
        System.out.println("Calibration target (relay output16 Hz, cue0): " + relayHz16cue0);
        System.out.println("additive deltaW=" + additiveDeltaW + ", contrastive deltaW=" + contrastiveDeltaW);

        // --- Section 1: main grid -- 4 conditions x 6 tasks x 20 seeds x 2 training modes. ---
        JSONArray rows = new JSONArray();
        Map<String, double[]> perSeedByKey = new LinkedHashMap<>();
        for (boolean train : new boolean[]{false, true}) for (int c = 0; c < conditionNames.length; c++) for (String task : TASKS) {
            double[] values = new double[SEEDS.length];
            for (int i = 0; i < SEEDS.length; i++) {
                double success = heldoutSuccess(conditionGraphs[c], SEEDS[i], task, conditionBias[c], conditionDeltaW[c], train);
                values[i] = success;
                rows.put(new JSONObject().put("condition", conditionNames[c]).put("trained", train).put("task", task).put("seed", SEEDS[i]).put("heldoutSuccess", success));
            }
            perSeedByKey.put(conditionNames[c] + ":" + train + ":" + task, values);
        }

        JSONArray comparisons = new JSONArray();
        for (boolean train : new boolean[]{false, true}) for (String task : TASKS) {
            double[] relayV = perSeedByKey.get("relay:" + train + ":" + task);
            double[] additiveV = perSeedByKey.get("direct-additive:" + train + ":" + task);
            double[] contrastiveV = perSeedByKey.get("direct-contrastive:" + train + ":" + task);
            double[] originalV = perSeedByKey.get("original:" + train + ":" + task);
            double[] relayMinusAdditive = new double[relayV.length], additiveMinusOriginal = new double[relayV.length], relayMinusOriginal = new double[relayV.length];
            for (int i = 0; i < relayV.length; i++) { relayMinusAdditive[i] = relayV[i] - additiveV[i]; additiveMinusOriginal[i] = additiveV[i] - originalV[i]; relayMinusOriginal[i] = relayV[i] - originalV[i]; }
            double[] raCi = bootstrapCi(relayMinusAdditive, 111L, 10000), aoCi = bootstrapCi(additiveMinusOriginal, 222L, 10000), roCi = bootstrapCi(relayMinusOriginal, 333L, 10000);
            comparisons.put(new JSONObject().put("trained", train).put("task", task)
                .put("meanOriginal", Arrays.stream(originalV).average().orElse(Double.NaN))
                .put("meanDirectAdditive", Arrays.stream(additiveV).average().orElse(Double.NaN))
                .put("meanDirectContrastive", Arrays.stream(contrastiveV).average().orElse(Double.NaN))
                .put("meanRelay", Arrays.stream(relayV).average().orElse(Double.NaN))
                .put("relayMinusAdditive_mean", raCi[0]).put("relayMinusAdditiveCi95Low", raCi[1]).put("relayMinusAdditiveCi95High", raCi[2])
                .put("additiveMinusOriginal_mean", aoCi[0]).put("additiveMinusOriginalCi95Low", aoCi[1]).put("additiveMinusOriginalCi95High", aoCi[2])
                .put("relayMinusOriginal_mean", roCi[0]).put("relayMinusOriginalCi95Low", roCi[1]).put("relayMinusOriginalCi95High", roCi[2])
                .put("relaySignificantlyBeatsAdditive", raCi[1] > 0).put("relaySignificantlyWorseThanAdditive", raCi[2] < 0));
        }

        JSONObject report = new JSONObject()
            .put("type", "fdb-a3-clean-signal-vs-structure-v1")
            .put("sourceCommitBase", "3462e0532aafeb459ea85c968078407af711f423")
            .put("branch", "research/fdb-growth-audit")
            .put("question", "A2 found direct-contrastive beats relay, but contrastive also suppresses the competing output while relay does not -- confounding amplitude with discrimination margin. A3 adds direct-additive (matches relay's own bias shape: only adds to the correct output) and calibrates every condition against the SAME seed range (A2 used disjoint ranges for relay vs direct), then measures both output channels under both cues to show the match, not assert it.")
            .put("crossCheckAgainstA2", new JSONObject().put("rowsChecked", a2Rows.size()).put("mismatches", mismatches))
            .put("calibration", new JSONObject().put("targetHz16_cue0_fromRelay", relayHz16cue0).put("additiveDeltaW", additiveDeltaW).put("contrastiveDeltaW", contrastiveDeltaW)
                .put("sameSeedBaseForAllConditions", CALIBRATION_SEED_BASE).put("trials", CALIBRATION_TRIALS)
                .put("hzTable", hzTable)
                .put("note", "hzTable shows output16/output17 under both cues for all four conditions at identical seed base -- direct-additive and relay should match on BOTH channels if the calibration and bias-shape fix worked; direct-contrastive should show a suppressed competing channel; original is the unbiased baseline."))
            .put("protocol", new JSONObject().put("trainEpisodes", 80).put("heldoutEpisodes", 40).put("seeds", new JSONArray(SEEDS)).put("seedCount", SEEDS.length)
                .put("conditions", new JSONArray().put("original").put("direct-additive (0->16:+dW, 1->17:+dW only, matches relay's purely-additive shape)").put("direct-contrastive (A2's bias, kept for continuity)").put("relay"))
                .put("bootstrap", "paired by seed, resampled with replacement, B=10000, 95% percentile interval"))
            .put("rows", rows)
            .put("comparisons", comparisons)
            .put("limitations", "Host CPU fixtures. Single calibration stimulus intensity (500Hz, 30ms). Spike-timing distributions, intensity sweep, window-duration sweep and per-decision compute cost (Sol's broader measurement list) are not covered here -- this file targets only the narrow additive-vs-relay comparison Sol asked for as the closing experiment of this series. A true recurrent (feedback) circuit on a state-holding task is explicitly out of scope here and remains open future work.");

        Path out = Paths.get(args.length == 0 ? "/tmp/fdb-a3-clean-signal-vs-structure.json" : args[0]);
        Files.write(out, report.toString(2).getBytes(StandardCharsets.UTF_8));
        System.out.println("PASS: A3 clean signal-vs-structure (" + rows.length() + " rows, " + comparisons.length() + " comparisons) written to " + out);
    }
}
