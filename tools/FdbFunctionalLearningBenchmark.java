package org.node.flyconsole;

import org.json.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Research Package A (docs/FDB_FUNCTIONAL_LEARNING_BENCHMARK_RU.md): does existing FDB
 * plasticity produce functional learning above frozen/fixed controls, and does adding
 * neurons help only when they add real reachable paths rather than mere array size?
 *
 * Does not modify FdbTemporalExperiment.java or its committed results; Section 0 below
 * re-runs it unmodified and diffs against docs/reports/fdb-2026-10-16/temporal.json as
 * a reproduction check before any new fixture is trusted. Task/episode semantics here
 * duplicate (not import -- the original is not designed for reuse) FdbTemporalExperiment's
 * Run.episode logic verbatim; Section 1's control-30 graph is byte-for-byte the same
 * fixture, used as an internal cross-check that the duplication introduced no drift.
 */
public final class FdbFunctionalLearningBenchmark {
    static final int[] INPUTS = range(0, 16), OUTPUTS = range(16, 12);
    static final String[] TASKS = {"immediate", "sequence", "hold", "delay5", "delay10", "reversal"};
    static final long[] SEEDS = {11, 23, 37, 53, 71, 89, 101, 127, 149, 163, 179, 197, 211, 229, 241, 263, 281, 307, 331, 349};
    static final String[] PROFILES = {"single-v1", "dual-v1", "dual-rate-v1", "frozen", "fixed-wired"};

    static int[] range(int start, int count) { int[] a = new int[count]; for (int i = 0; i < count; i++) a[i] = start + i; return a; }

    // --- CSR builder: edges need not be pre-sorted by source; degree-counted and bucketed. ---
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
    static Graph controlGraph() { return build(30, CORE_EDGES); } // byte-for-byte FdbTemporalExperiment.graph()
    static Graph ballastGraph() { return build(90, CORE_EDGES); } // same core, 60 neurons appended with zero edges: pure array-size increase
    // Relay neurons 30/31 need their own afferent drive (0->30, 1->31) as well as their efferent
    // edge to a target (30->16, 31->17); an earlier version of this fixture wired only the efferent
    // half, leaving 30/31 permanently silent -- caught by the cross-check below, not assumed away.
    static final int[][] FUNCTIONAL_EXTRA_EDGES = {{0, 30, 20}, {30, 16, 20}, {1, 31, 20}, {31, 17, 20}};
    static Graph functionalGraph() { // same core plus a disambiguating relay: cue0 gets an extra push to 16, cue1 an extra push to 17
        int[][] edges = new int[CORE_EDGES.length + FUNCTIONAL_EXTRA_EDGES.length][];
        System.arraycopy(CORE_EDGES, 0, edges, 0, CORE_EDGES.length);
        System.arraycopy(FUNCTIONAL_EXTRA_EDGES, 0, edges, CORE_EDGES.length, FUNCTIONAL_EXTRA_EDGES.length);
        return build(90, edges);
    }

    static final class Run {
        final Graph graph; final GraphDelta delta; final FdbLearning learner; final Engine engine;
        final Engine.Options options = new Engine.Options(); final List<Double> timings = new ArrayList<>();
        int decision; final long seed;
        Run(Graph graph, long seed, String profile, boolean trainBase, String plasticityMode) {
            this.graph = graph; this.seed = seed;
            delta = new GraphDelta(graph.ids.length, 2048);
            engine = new Engine(graph);
            int maxEdges = (plasticityMode.equals("wexo") || plasticityMode.equals("expanded")) ? 2048 : 1024;
            learner = new FdbLearning(graph, delta, INPUTS, OUTPUTS, .1, maxEdges, 127, trainBase, plasticityMode);
            learner.creditProfile(profile.equals("frozen") || profile.equals("fixed-wired") ? "single-v1" : profile);
            learner.seed(seed);
            options.delta = delta;
            if (profile.equals("fixed-wired")) { // hand-wired upper-bound control: bypasses FdbLearning entirely, never trained
                delta.addWeightDelta(0, 16, 12); delta.addWeightDelta(0, 17, -12);
                delta.addWeightDelta(1, 16, -12); delta.addWeightDelta(1, 17, 12);
            }
        }
        FdbLearning.Decision decide(int cue, boolean train, boolean distract, double rate) {
            double[] rates = new double[16]; rates[cue] = rate;
            long at = System.nanoTime();
            Engine.Result r = engine.advance(INPUTS, rates, 30, options, new AtomicBoolean());
            FdbLearning.Decision d = learner.decide("t" + (decision++), r, distract ? new int[]{0, 4} : new int[]{1, 2}, 4095, 100, train ? .1 : 0, train, null);
            timings.add((System.nanoTime() - at) / 1e6);
            return d;
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

    static double heldoutSuccess(Graph graph, long seed, String task, String profile, boolean trainBase, String plasticityMode) {
        Run r = new Run(graph, seed, profile, trainBase, plasticityMode);
        boolean trains = !profile.equals("frozen") && !profile.equals("fixed-wired");
        for (int e = 0; e < 80; e++) r.episode(task, e, trains, false);
        r.learner.boundary();
        int held = 0;
        for (int e = 0; e < 40; e++) held += r.episode(task, e, false, true) ? 1 : 0;
        return held / 40.0;
    }

    // --- Section 0: unmodified reproduction check against the committed Package B/temporal report ---
    static JSONObject reproductionCheck() throws Exception {
        Path tmp = Files.createTempFile("fdb-temporal-repro", "");
        Files.delete(tmp);
        FdbTemporalExperiment.main(new String[]{tmp.toString()});
        JSONObject committed = new JSONObject(new String(Files.readAllBytes(Paths.get("docs/reports/fdb-2026-10-16/temporal.json")), StandardCharsets.UTF_8));
        JSONObject reproduced = new JSONObject(new String(Files.readAllBytes(Paths.get(tmp + ".json")), StandardCharsets.UTF_8));
        Map<String, Double> committedByKey = new HashMap<>(), reproducedByKey = new HashMap<>();
        for (int i = 0; i < committed.getJSONArray("rows").length(); i++) { JSONObject row = committed.getJSONArray("rows").getJSONObject(i); committedByKey.put(row.getString("task") + ":" + row.getInt("seed") + ":" + row.getString("profile"), row.getDouble("heldoutSuccess")); }
        for (int i = 0; i < reproduced.getJSONArray("rows").length(); i++) { JSONObject row = reproduced.getJSONArray("rows").getJSONObject(i); reproducedByKey.put(row.getString("task") + ":" + row.getInt("seed") + ":" + row.getString("profile"), row.getDouble("heldoutSuccess")); }
        int mismatches = 0;
        for (Map.Entry<String, Double> e : committedByKey.entrySet()) if (!e.getValue().equals(reproducedByKey.get(e.getKey()))) mismatches++;
        Files.deleteIfExists(Paths.get(tmp + ".json")); Files.deleteIfExists(Paths.get(tmp + ".csv"));
        return new JSONObject().put("section", "reproduction_check").put("committedRows", committedByKey.size()).put("reproducedRows", reproducedByKey.size()).put("mismatches", mismatches)
            .put("finding", mismatches == 0 ? "CONFIRMED: unmodified FdbTemporalExperiment reproduces all " + committedByKey.size() + " committed heldoutSuccess values exactly on this commit." : "MISMATCH: original experiment is not reproducible on this commit, investigate before trusting Section 1-3.");
    }

    static double[] bootstrapCi(double[] perSeed, long rngSeed, int b) {
        Random rng = new Random(rngSeed); double[] means = new double[b]; int n = perSeed.length;
        for (int i = 0; i < b; i++) { double sum = 0; for (int j = 0; j < n; j++) sum += perSeed[rng.nextInt(n)]; means[i] = sum / n; }
        Arrays.sort(means);
        double mean = 0; for (double v : perSeed) mean += v; mean /= n;
        return new double[]{mean, means[(int) (b * .025)], means[(int) (b * .975) - 1]};
    }

    public static void main(String[] args) throws Exception {
        JSONObject repro = reproductionCheck();
        System.out.println(repro.getString("finding"));
        if (repro.getInt("mismatches") != 0) throw new AssertionError("Reproduction check failed; refusing to run new fixtures against a drifted baseline.");

        Map<String, Graph> graphs = new LinkedHashMap<>();
        graphs.put("control-30", controlGraph()); graphs.put("ballast-90", ballastGraph()); graphs.put("functional-90", functionalGraph());

        // Internal cross-check: this file's own episode/decide/feedback duplication must match the
        // original's 5-seed control-30 numbers exactly before the 90-neuron fixtures are trusted.
        int crossCheckMismatches = 0;
        JSONObject committedTemporal = new JSONObject(new String(Files.readAllBytes(Paths.get("docs/reports/fdb-2026-10-16/temporal.json")), StandardCharsets.UTF_8));
        Map<String, Double> committedByKey = new HashMap<>();
        for (int i = 0; i < committedTemporal.getJSONArray("rows").length(); i++) { JSONObject row = committedTemporal.getJSONArray("rows").getJSONObject(i); committedByKey.put(row.getString("task") + ":" + row.getInt("seed") + ":" + row.getString("profile"), row.getDouble("heldoutSuccess")); }
        for (String task : TASKS) for (long seed : new long[]{11, 23, 37, 53, 71}) for (String profile : new String[]{"single-v1", "dual-v1", "dual-rate-v1", "frozen"}) {
            Double committed = committedByKey.get(task + ":" + seed + ":" + profile);
            if (committed == null) continue;
            double duplicated = heldoutSuccess(graphs.get("control-30"), seed, task, profile, true, "expanded");
            if (!committed.equals(duplicated)) crossCheckMismatches++;
        }
        System.out.println(crossCheckMismatches == 0 ? "CONFIRMED: this tool's duplicated episode/decide/feedback logic matches the original exactly on control-30 (" + committedByKey.size() + " keys checked where overlapping)." : "MISMATCH: duplicated logic diverges from the original in " + crossCheckMismatches + " cases -- do not trust Section 1-3 until fixed.");
        if (crossCheckMismatches != 0) throw new AssertionError("Episode logic duplication diverged from FdbTemporalExperiment.");

        // --- Section 1: main grid -- 3 graphs x 6 tasks x 20 seeds x 5 profiles ---
        JSONArray rows = new JSONArray();
        Map<String, double[]> perSeedByKey = new LinkedHashMap<>(); // key = graph:task:profile -> values aligned to SEEDS order
        for (Map.Entry<String, Graph> ge : graphs.entrySet()) for (String task : TASKS) for (String profile : PROFILES) {
            double[] values = new double[SEEDS.length];
            for (int i = 0; i < SEEDS.length; i++) {
                long seed = SEEDS[i];
                double success = heldoutSuccess(ge.getValue(), seed, task, profile, true, "expanded");
                values[i] = success;
                rows.put(new JSONObject().put("graph", ge.getKey()).put("task", task).put("seed", seed).put("profile", profile).put("heldoutSuccess", success));
            }
            perSeedByKey.put(ge.getKey() + ":" + task + ":" + profile, values);
        }

        // Sanity guard: functional-90 must actually differ from control-30/ballast-90 somewhere, or the
        // relay fixture is silently inert again (exactly the bug an earlier version of this file had).
        boolean functionalDiffersFromBallast = false;
        for (String task : TASKS) for (String profile : new String[]{"single-v1", "dual-v1", "dual-rate-v1"}) {
            double[] a = perSeedByKey.get("functional-90:" + task + ":" + profile), b = perSeedByKey.get("ballast-90:" + task + ":" + profile);
            if (!Arrays.equals(a, b)) functionalDiffersFromBallast = true;
        }
        System.out.println(functionalDiffersFromBallast ? "CONFIRMED: functional-90 produces at least one different outcome from ballast-90 -- the relay fixture is actually exercised." : "WARNING: functional-90 is bit-identical to ballast-90 on every row -- the relay fixture is inert; do not report a topology effect.");

        // Paired-by-seed bootstrap CI: profile vs frozen on the SAME graph+task+seed, resampled over seeds (not episodes).
        JSONArray comparisons = new JSONArray();
        for (Map.Entry<String, Graph> ge : graphs.entrySet()) for (String task : TASKS) for (String profile : new String[]{"single-v1", "dual-v1", "dual-rate-v1", "fixed-wired"}) {
            double[] values = perSeedByKey.get(ge.getKey() + ":" + task + ":" + profile);
            double[] frozen = perSeedByKey.get(ge.getKey() + ":" + task + ":frozen");
            double[] diff = new double[values.length];
            for (int i = 0; i < diff.length; i++) diff[i] = values[i] - frozen[i];
            double[] ci = bootstrapCi(diff, 12345L, 10000);
            comparisons.put(new JSONObject().put("graph", ge.getKey()).put("task", task).put("profile", profile)
                .put("meanHeldoutSuccess", Arrays.stream(values).average().orElse(Double.NaN))
                .put("meanDiffVsFrozen", ci[0]).put("diffVsFrozenCi95Low", ci[1]).put("diffVsFrozenCi95High", ci[2])
                .put("significantlyAboveFrozen", ci[1] > 0).put("significantlyBelowFrozen", ci[2] < 0));
        }
        // Graph-vs-graph comparisons at fixed profile: isolates size effect (ballast-30 vs control) from topology effect (functional vs ballast).
        JSONArray graphComparisons = new JSONArray();
        for (String profile : new String[]{"single-v1", "dual-v1", "dual-rate-v1"}) for (String task : TASKS) {
            double[] control = perSeedByKey.get("control-30:" + task + ":" + profile);
            double[] ballast = perSeedByKey.get("ballast-90:" + task + ":" + profile);
            double[] functional = perSeedByKey.get("functional-90:" + task + ":" + profile);
            double[] sizeDiff = new double[control.length], topologyDiff = new double[control.length];
            for (int i = 0; i < control.length; i++) { sizeDiff[i] = ballast[i] - control[i]; topologyDiff[i] = functional[i] - ballast[i]; }
            double[] sizeCi = bootstrapCi(sizeDiff, 54321L, 10000), topologyCi = bootstrapCi(topologyDiff, 98765L, 10000);
            graphComparisons.put(new JSONObject().put("profile", profile).put("task", task)
                .put("sizeEffect_ballastMinusControl", sizeCi[0]).put("sizeEffectCi95Low", sizeCi[1]).put("sizeEffectCi95High", sizeCi[2])
                .put("topologyEffect_functionalMinusBallast", topologyCi[0]).put("topologyEffectCi95Low", topologyCi[1]).put("topologyEffectCi95High", topologyCi[2]));
        }

        // --- Section 2: channel ablation on functional-90, immediate + delay10, dual-v1, 20 seeds ---
        JSONArray ablationRows = new JSONArray();
        Graph functional = graphs.get("functional-90");
        for (String task : new String[]{"immediate", "delay10"}) for (boolean trainBase : new boolean[]{true, false}) for (String mode : new String[]{"base", "dynamics"}) {
            double[] values = new double[SEEDS.length];
            for (int i = 0; i < SEEDS.length; i++) values[i] = heldoutSuccess(functional, SEEDS[i], task, "dual-v1", trainBase, mode);
            double mean = Arrays.stream(values).average().orElse(Double.NaN);
            ablationRows.put(new JSONObject().put("task", task).put("trainBase_deltaWChannel", trainBase).put("plasticityMode", mode).put("thresholdChannelActive", mode.equals("dynamics")).put("meanHeldoutSuccess", mean));
        }

        JSONObject report = new JSONObject()
            .put("type", "fdb-functional-learning-benchmark-v1")
            .put("sourceCommitBase", "3462e0532aafeb459ea85c968078407af711f423")
            .put("branch", "research/fdb-growth-audit")
            .put("protocol", new JSONObject().put("trainEpisodes", 80).put("heldoutEpisodes", 40).put("seeds", new JSONArray(SEEDS)).put("seedCount", SEEDS.length)
                .put("graphs", new JSONArray().put("control-30 (original FdbTemporalExperiment fixture, unmodified)").put("ballast-90 (control-30 core + 60 zero-edge neurons: pure array-size increase)").put("functional-90 (control-30 core + 4 reachable disambiguating relay edges -- 0->30->16 and 1->31->17 -- through 60 extra neurons, same size as ballast-90)"))
                .put("profiles", new JSONArray(PROFILES))
                .put("bootstrap", "paired by seed, resampled with replacement, B=10000, 95% percentile interval"))
            .put("reproductionCheck", repro)
            .put("functionalFixtureActuallyExercised", functionalDiffersFromBallast)
            .put("rows", rows)
            .put("comparisonsVsFrozen", comparisons)
            .put("graphComparisons_sizeVsTopology", graphComparisons)
            .put("channelAblation_functionalGraph_dualV1", ablationRows)
            .put("limitations", "Host CPU fixtures, not ROM gameplay or Android. 20 seeds, 6 controlled tasks, 3 graphs -- scope bounded by this session's time budget, not by the method. ballast/functional graphs are purpose-built minimal contrasts (2-edge difference), not representative of FlyWire-scale topology. No reload-parity or GPU-path check repeated here (already covered by FdbLearningCheck/GpuLayerSyncCheck). Statistical significance is per task+graph+profile, not corrected for the many comparisons made across the whole grid.");

        Path out = Paths.get(args.length == 0 ? "/tmp/fdb-functional-learning-benchmark.json" : args[0]);
        Files.write(out, report.toString(2).getBytes(StandardCharsets.UTF_8));
        System.out.println("PASS: functional learning benchmark (" + rows.length() + " rows, " + comparisons.length() + " frozen-comparisons, " + graphComparisons.length() + " graph-comparisons, " + ablationRows.length() + " ablation rows) written to " + out);
    }
}
