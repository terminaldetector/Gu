package org.node.flyconsole;

import org.json.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Research Package A2 (Sol's review of Package A, 2026-10-18): does the two-hop relay
 * circuit from functional-90 beat a one-hop direct weight boost CALIBRATED to deliver
 * the same output firing rate, or is Package A's "topology effect" actually just a
 * larger raw signal to the correct output neuron that a direct boost would match
 * equally well? Separates "more amplitude" from "structural/temporal specialization."
 *
 * Does not modify FdbFunctionalLearningBenchmark.java, FdbTemporalExperiment.java or
 * any production file; episode/decide/feedback semantics are duplicated verbatim from
 * FdbFunctionalLearningBenchmark.java (itself a duplication of FdbTemporalExperiment.java),
 * and Section 0 below cross-checks this duplication against Package A's own committed
 * numbers before any new condition is trusted.
 */
public final class FdbA2SignalVsStructure {
    static final int[] INPUTS = range(0, 16), OUTPUTS = range(16, 12);
    static final String[] TASKS = {"immediate", "sequence", "hold", "delay5", "delay10", "reversal"};
    static final long[] SEEDS = {11, 23, 37, 53, 71, 89, 101, 127, 149, 163, 179, 197, 211, 229, 241, 263, 281, 307, 331, 349};

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
    static Graph originalGraph() { return build(90, CORE_EDGES); } // ballast-90 from Package A: same array size as relay, zero bias
    static Graph relayGraph() {
        int[][] edges = new int[CORE_EDGES.length + RELAY_EXTRA_EDGES.length][];
        System.arraycopy(CORE_EDGES, 0, edges, 0, CORE_EDGES.length);
        System.arraycopy(RELAY_EXTRA_EDGES, 0, edges, CORE_EDGES.length, RELAY_EXTRA_EDGES.length);
        return build(90, edges);
    }

    // --- Calibration: measure output16 Hz under cue0 stimulation, no learner, no training. ---
    static double measureOutputHz(Graph graph, GraphDelta biasOrNull, double deltaW, int output, int cue, int trials, long seedBase) {
        double sum = 0;
        for (int t = 0; t < trials; t++) {
            GraphDelta delta = biasOrNull == null ? null : new GraphDelta(graph.ids.length);
            if (biasOrNull != null) {
                delta.addWeightDelta(0, 16, (float) deltaW); delta.addWeightDelta(0, 17, (float) -deltaW);
                delta.addWeightDelta(1, 16, (float) -deltaW); delta.addWeightDelta(1, 17, (float) deltaW);
            }
            Engine engine = new Engine(graph);
            engine.reset(seedBase + t);
            Engine.Options opt = new Engine.Options(); opt.delta = delta;
            double[] rates = new double[16]; rates[cue] = 500;
            Engine.Result r = engine.advance(INPUTS, rates, 30, opt, new AtomicBoolean());
            sum += r.counts[output] * 10000.0 / r.steps;
        }
        return sum / trials;
    }

    static final class Calibration {
        double relayHz, directHz, deltaW; int iterations;
    }

    static Calibration calibrate() {
        Graph original = originalGraph(), relay = relayGraph();
        double relayHz = measureOutputHz(relay, null, 0, 16, 0, 200, 1000);
        // Binary search deltaW in [0,30] on `original` so that output16's Hz under cue0 matches relayHz.
        double lo = 0, hi = 30, best = 0, bestHz = measureOutputHz(original, new GraphDelta(90), 0, 16, 0, 200, 2000);
        int iterations = 0;
        for (int i = 0; i < 24; i++) {
            double mid = (lo + hi) / 2;
            double hz = measureOutputHz(original, new GraphDelta(90), mid, 16, 0, 200, 2000);
            iterations++;
            if (Math.abs(hz - relayHz) < Math.abs(bestHz - relayHz)) { best = mid; bestHz = hz; }
            if (hz < relayHz) lo = mid; else hi = mid;
        }
        Calibration c = new Calibration(); c.relayHz = relayHz; c.directHz = bestHz; c.deltaW = best; c.iterations = iterations;
        return c;
    }

    static final class Run {
        final Graph graph; final GraphDelta delta; final FdbLearning learner; final Engine engine;
        final Engine.Options options = new Engine.Options(); int decision; final long seed;
        Run(Graph graph, long seed, double deltaWBias) {
            this.graph = graph; this.seed = seed;
            delta = new GraphDelta(graph.ids.length, 2048);
            if (deltaWBias != 0) { delta.addWeightDelta(0, 16, (float) deltaWBias); delta.addWeightDelta(0, 17, (float) -deltaWBias); delta.addWeightDelta(1, 16, (float) -deltaWBias); delta.addWeightDelta(1, 17, (float) deltaWBias); }
            engine = new Engine(graph);
            learner = new FdbLearning(graph, delta, INPUTS, OUTPUTS, .1, 2048, 127, true, "expanded");
            learner.seed(seed);
            options.delta = delta;
        }
        // `train` is threaded per call (not a Run-level field): the 80 training episodes pass the
        // condition's training flag, the 40 held-out episodes always pass false, exactly like
        // FdbTemporalExperiment/FdbFunctionalLearningBenchmark. An earlier version of this file used
        // a Run-level field instead, so held-out episodes kept training when the condition trained --
        // caught by the Section 0 cross-check against Package A before any new row was trusted.
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

    static double heldoutSuccess(Graph graph, long seed, String task, double deltaWBias, boolean train) {
        Run r = new Run(graph, seed, deltaWBias);
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
        // --- Section 0: cross-check this file's duplicated episode logic against Package A's own committed numbers,
        // using the untrained-equivalent path is not directly comparable (Package A always trains "single-v1" the
        // same way); instead cross-check the TRAINED, zero-bias, relay-graph condition against Package A's
        // functional-90/single-v1 rows, which must be produced by equivalent logic given equivalent inputs.
        JSONObject packageA = new JSONObject(new String(Files.readAllBytes(Paths.get("docs/reports/research-fdb-growth-audit-2026-10-17/functional-learning-benchmark.json")), StandardCharsets.UTF_8));
        Map<String, Double> packageARows = new HashMap<>();
        for (int i = 0; i < packageA.getJSONArray("rows").length(); i++) {
            JSONObject row = packageA.getJSONArray("rows").getJSONObject(i);
            if (row.getString("graph").equals("functional-90") && row.getString("profile").equals("single-v1"))
                packageARows.put(row.getString("task") + ":" + row.getInt("seed"), row.getDouble("heldoutSuccess"));
        }
        int mismatches = 0;
        Graph relay = relayGraph();
        for (String task : TASKS) for (long seed : SEEDS) {
            Double expected = packageARows.get(task + ":" + seed);
            if (expected == null) continue;
            double actual = heldoutSuccess(relay, seed, task, 0, true);
            if (!expected.equals(actual)) mismatches++;
        }
        System.out.println(mismatches == 0
            ? "CONFIRMED: this tool's duplicated logic reproduces all " + packageARows.size() + " Package A functional-90/single-v1 rows exactly."
            : "MISMATCH: " + mismatches + " rows diverge from Package A -- do not trust Section 1-2.");
        if (mismatches != 0) throw new AssertionError("Episode logic duplication diverged from FdbFunctionalLearningBenchmark/Package A.");

        // --- Calibration ---
        Calibration cal = calibrate();
        System.out.println(String.format(Locale.US, "Calibration: relay output16 Hz=%.2f, direct deltaW=%.4f achieves Hz=%.2f (diff=%.2f) after %d bisection steps",
            cal.relayHz, cal.deltaW, cal.directHz, cal.directHz - cal.relayHz, cal.iterations));

        Graph original = originalGraph();
        Map<String, double[]> perSeedByKey = new LinkedHashMap<>();
        JSONArray rows = new JSONArray();
        // Three graph/bias conditions x two training modes x 6 tasks x 20 seeds.
        Object[][] conditions = {
            {"original", original, 0.0}, {"direct-calibrated", original, cal.deltaW}, {"relay", relay, 0.0}
        };
        for (boolean train : new boolean[]{false, true}) for (Object[] cond : conditions) for (String task : TASKS) {
            double[] values = new double[SEEDS.length];
            for (int i = 0; i < SEEDS.length; i++) {
                double success = heldoutSuccess((Graph) cond[1], SEEDS[i], task, (Double) cond[2], train);
                values[i] = success;
                rows.put(new JSONObject().put("condition", cond[0]).put("trained", train).put("task", task).put("seed", SEEDS[i]).put("heldoutSuccess", success));
            }
            perSeedByKey.put(cond[0] + ":" + train + ":" + task, values);
        }

        JSONArray comparisons = new JSONArray();
        for (boolean train : new boolean[]{false, true}) for (String task : TASKS) {
            double[] relayV = perSeedByKey.get("relay:" + train + ":" + task);
            double[] directV = perSeedByKey.get("direct-calibrated:" + train + ":" + task);
            double[] originalV = perSeedByKey.get("original:" + train + ":" + task);
            double[] relayMinusDirect = new double[relayV.length], directMinusOriginal = new double[relayV.length], relayMinusOriginal = new double[relayV.length];
            for (int i = 0; i < relayV.length; i++) { relayMinusDirect[i] = relayV[i] - directV[i]; directMinusOriginal[i] = directV[i] - originalV[i]; relayMinusOriginal[i] = relayV[i] - originalV[i]; }
            double[] rdCi = bootstrapCi(relayMinusDirect, 111L, 10000), doCi = bootstrapCi(directMinusOriginal, 222L, 10000), roCi = bootstrapCi(relayMinusOriginal, 333L, 10000);
            comparisons.put(new JSONObject().put("trained", train).put("task", task)
                .put("meanRelay", Arrays.stream(relayV).average().orElse(Double.NaN))
                .put("meanDirectCalibrated", Arrays.stream(directV).average().orElse(Double.NaN))
                .put("meanOriginal", Arrays.stream(originalV).average().orElse(Double.NaN))
                .put("relayMinusDirect_mean", rdCi[0]).put("relayMinusDirectCi95Low", rdCi[1]).put("relayMinusDirectCi95High", rdCi[2])
                .put("directMinusOriginal_mean", doCi[0]).put("directMinusOriginalCi95Low", doCi[1]).put("directMinusOriginalCi95High", doCi[2])
                .put("relayMinusOriginal_mean", roCi[0]).put("relayMinusOriginalCi95Low", roCi[1]).put("relayMinusOriginalCi95High", roCi[2])
                .put("relaySignificantlyBeatsDirect", rdCi[1] > 0).put("relaySignificantlyWorseThanDirect", rdCi[2] < 0));
        }

        JSONObject report = new JSONObject()
            .put("type", "fdb-a2-signal-vs-structure-v1")
            .put("sourceCommitBase", "3462e0532aafeb459ea85c968078407af711f423")
            .put("branch", "research/fdb-growth-audit")
            .put("question", "Package A found that functional-90 (a 4-edge two-hop relay) beats ballast-90 on most tasks. Is that because the relay delivers more raw signal to the correct output neuron, or because of something structural/temporal about the two-hop path that an equally-strong one-hop boost cannot replicate?")
            .put("calibration", new JSONObject().put("relayOutput16Hz_cue0", cal.relayHz).put("directDeltaW", cal.deltaW).put("directOutput16Hz_cue0", cal.directHz).put("hzDifference", cal.directHz - cal.relayHz).put("bisectionSteps", cal.iterations)
                .put("method", "200-trial average output16 firing rate under a single cue0 (500Hz, 30ms) stimulation, no learner, no training. Direct deltaW found by 24-step bisection on [0,30] applied symmetrically to existing edges 0->16/0->17/1->16/1->17 via GraphDelta.addWeightDelta, matching relay's output16 Hz under the same stimulus. Matching assumed symmetric for cue1/output17 by construction (identical relay weights and identical deltaW on both sides) -- not independently verified for output17."))
            .put("protocol", new JSONObject().put("trainEpisodes", 80).put("heldoutEpisodes", 40).put("seeds", new JSONArray(SEEDS)).put("seedCount", SEEDS.length)
                .put("conditions", new JSONArray().put("original (ballast-90 core, zero bias)").put("direct-calibrated (ballast-90 core + symmetric deltaW calibrated to match relay's output16 Hz)").put("relay (functional-90: same core + 4-edge two-hop relay, zero deltaW bias)"))
                .put("trainingModes", new JSONArray().put("untrained (train=false throughout: isolates the raw circuit/signal effect, no FdbLearning plasticity)").put("trained (single-v1 FdbLearning plasticity on top of the fixed graph+bias, 80 training + 40 held-out episodes)"))
                .put("bootstrap", "paired by seed, resampled with replacement, B=10000, 95% percentile interval"))
            .put("crossCheckAgainstPackageA", new JSONObject().put("rowsChecked", packageARows.size()).put("mismatches", mismatches))
            .put("rows", rows)
            .put("comparisons", comparisons)
            .put("limitations", "Host CPU fixtures. Calibration matches only output16 under cue0; output17/cue1 match relies on the fixture's built-in symmetry, not independently measured. Only one calibration point (500Hz, 30ms, the standard episode stimulus) is used; a different stimulus intensity could shift the Hz-matching deltaW. 20 seeds, not corrected for multiple comparisons across 2 training modes x 6 tasks x 3 pairwise contrasts = 36 comparisons.");

        Path out = Paths.get(args.length == 0 ? "/tmp/fdb-a2-signal-vs-structure.json" : args[0]);
        Files.write(out, report.toString(2).getBytes(StandardCharsets.UTF_8));
        System.out.println("PASS: A2 signal-vs-structure (" + rows.length() + " rows, " + comparisons.length() + " comparisons) written to " + out);
    }
}
