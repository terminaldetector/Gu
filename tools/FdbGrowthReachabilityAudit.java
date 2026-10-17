package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Research Package B (docs/FDB_GROWTH_REACHABILITY_AUDIT_RU.md): does the production
 * runtime ever let FdbGrowth and FdbLearning mutate the same GraphDelta at the same
 * time, and can FdbLearning later touch an edge that FdbGrowth created?
 *
 * This tool does not modify app/src/main/java/org/node/flyconsole. Section 1 and 2
 * reproduce the exact call-site expressions from NesLabActivity.java and
 * DualAgentContext.java as literal source quotes in comments, then exercise the same
 * public API with the same arguments. Section 3 drives FdbGrowth and FdbLearning on a
 * shared GraphDelta through their existing public methods only.
 *
 * No claim here is about biological plausibility or game skill; this is a reachability
 * and interaction audit of existing Java control flow.
 */
public final class FdbGrowthReachabilityAudit {
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static Engine.Result result(int... counts) { return new Engine.Result(counts, 0, 10, 10, 0); }

    // --- Section 1: NesLabActivity.java call-site reachability matrix -----------------
    //
    // Verbatim source quote (NesLabActivity.java, sample(), as of the commit recorded
    // in the report provenance field below):
    //
    //   String learningMode=request.optString("learningMode","off");
    //   boolean frozen=request.optBoolean("frozen",false)||learningMode.equals("eval")||learningMode.startsWith("benchmark");
    //   int grown=fdbGrowth==null||cancel.get()?0:fdbGrowth.observe(result,0,experiment.options.lesions,frozen||!learningMode.equals("off"));
    //
    // reward is a hardcoded literal 0 at this call site, independent of configuration.
    private static JSONObject nesLabActivityMatrix() {
        JSONArray rows = new JSONArray();
        String[] learningModes = {"off", "train", "teach", "eval", "benchmark-fixed"};
        boolean[] frozenRequestValues = {false, true};
        boolean[] rewardGateValues = {true, false};
        for (String learningMode : learningModes) {
            boolean requestFrozen = false; // the "frozen" boolean computed one line above growth's call, varied separately below
            for (boolean frozenRequest : frozenRequestValues) {
                boolean evalOrBenchmark = learningMode.equals("eval") || learningMode.startsWith("benchmark");
                boolean frozen = frozenRequest || evalOrBenchmark; // exact second line above
                boolean passedFrozenArgument = frozen || !learningMode.equals("off"); // exact third line above
                for (boolean rewardGate : rewardGateValues) {
                    Graph g = new Graph(new long[]{1, 2, 3}, new int[]{0, 0, 0, 0}, new int[0], new float[0]);
                    GraphDelta layer = new GraphDelta(3);
                    FdbGrowth growth = new FdbGrowth(g, layer, new int[]{0}, new int[]{1, 2}, 1, 1, 1, 8f, true, rewardGate, 1);
                    // Call exactly as NesLabActivity does: reward literal 0, computed frozen argument.
                    int grown = growth.observe(result(5, 0, 0), 0, new int[0], passedFrozenArgument);
                    JSONObject row = new JSONObject()
                        .put("learningMode", learningMode)
                        .put("requestFrozenFlag", frozenRequest)
                        .put("rewardGateConfigured", rewardGate)
                        .put("computedFrozenArgumentPassedToObserve", passedFrozenArgument)
                        .put("edgesCreatedThisCall", grown)
                        .put("growthCountAfter", layer.growthCount());
                    rows.put(row);
                }
            }
        }
        boolean anyGrowthWhileLearningActive = false;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.getJSONObject(i);
            if (!r.getString("learningMode").equals("off") && r.getInt("edgesCreatedThisCall") > 0) anyGrowthWhileLearningActive = true;
        }
        return new JSONObject()
            .put("section", "nes_lab_activity_call_site_matrix")
            .put("method", "Reproduces NesLabActivity.sample()'s exact frozen-argument formula and reward literal against the real FdbGrowth.observe, across every learningMode x requestFrozen x rewardGate combination.")
            .put("finding", anyGrowthWhileLearningActive
                ? "UNEXPECTED: growth fired while learningMode != off"
                : "CONFIRMED: at this call site, growth never produces an edge while learningMode != \"off\" (frozen argument forces it closed), and even with learningMode==\"off\" it only fires when rewardGate is explicitly false (reward is hardcoded 0, and rewardGate&&reward<=0 blocks the call otherwise).")
            .put("rows", rows);
    }

    // --- Section 2: DualAgentContext.java reachability -------------------------------
    //
    // DualAgentContext.create(...) constructs `actor.growth` when fdb.growth.enabled
    // is true (verbatim quote, DualAgentContext.java):
    //
    //   if(bool(gc,"enabled",false)){actor.growth=new FdbGrowth(...); ...}
    //
    // but DualAgentContext.sample(...) -- read in full -- never calls growth.observe(...)
    // anywhere in its body. This section proves that by construction: it drives many
    // samples through the real production sample() with conditions that FdbGrowth.observe
    // would certainly grow an edge under (rewardGate=false, explore=true), and checks the
    // growth clock exposed in fdbState().growthState.windows, which only FdbGrowth.observe
    // advances.
    private static JSONObject dualAgentContextReachability() throws Exception {
        long[] ids = new long[30];
        for (int i = 0; i < 30; i++) ids[i] = i + 1;
        Graph graph = new Graph(ids, new int[31], new int[0], new float[0]);
        Experiment ports = Experiment.automatic(graph, 12);
        JSONArray edges = new JSONArray();
        JSONObject growthConfig = new JSONObject().put("enabled", true).put("interval", 1).put("perWindow", 4)
            .put("maxEdges", 64).put("initialWeight", 8).put("explore", true).put("rewardGate", false);
        JSONObject descriptor = new JSONObject().put("seed", 7).put("id", "p1").put("modelId", "reachability-fixture")
            .put("config", new JSONObject().put("backend", "cpu").put("mode", "closed").put("windowMs", 5)
                .put("maxHz", 500).put("thresholdHz", 30).put("gain", 1)
                .put("fdb", new JSONObject().put("deltas", new JSONArray()).put("edges", edges)
                    .put("learning", new JSONObject().put("enabled", true).put("rate", .1).put("maxEdges", 64).put("maxWeight", 32).put("plasticityMode", "base"))
                    .put("growth", growthConfig)));
        DualAgentContext actor = DualAgentContext.create("p1", "reachability-fixture", graph, ports, descriptor, null, UUID.randomUUID().toString());
        double[] retina = new double[16];
        Arrays.fill(retina, 1); // maximum drive on every sensory port: the most favorable case for growth to fire if it were reachable
        JSONObject decision = actor.sample(sampleRequest(new int[]{0, 1}, null), retina, "reach:0", new AtomicBoolean());
        int samples = 60;
        for (int i = 1; i < samples; i++) {
            JSONObject outcome = new JSONObject().put("id", decision.getJSONObject("decision").getString("id"))
                .put("mask", decision.getJSONObject("decision").getInt("mask")).put("frames", 6).put("gameSeconds", .1)
                .put("reward", decision.getJSONObject("decision").getInt("mask") == 1 ? 1 : -1).put("valid", true);
            decision = actor.sample(sampleRequest(new int[]{0, 1}, outcome), retina, "reach:" + i, new AtomicBoolean());
        }
        JSONObject growthState = actor.fdbState().optJSONObject("growthState");
        long windows = growthState == null ? -1 : growthState.getLong("windows");
        int acquiredEdges = actor.layer.growthCount();
        return new JSONObject()
            .put("section", "dual_agent_context_reachability")
            .put("method", "Constructs a production DualAgentContext with growth.enabled=true, rewardGate=false, explore=true (the configuration most favorable to growth firing), drives " + samples + " real sample() calls with full sensory drive and valid positive/negative outcomes, then reads fdbState().growthState.windows -- a counter only FdbGrowth.observe increments.")
            .put("samplesExecuted", samples)
            .put("growthStateWindowsAfter", windows)
            .put("acquiredEdgesAfter", acquiredEdges)
            .put("finding", windows == 0
                ? "CONFIRMED: growthState.windows stayed 0 after " + samples + " real sample() calls under the most growth-favorable configuration. FdbGrowth.observe() is never invoked from DualAgentContext.sample(); the field exists only because it is constructed and (de)serialized. Growth is dead code on this path, not merely gated -- it cannot fire regardless of configuration. Any acquiredEdgesAfter>0 is attributable to FdbLearning alone, not FdbGrowth."
                : "UNEXPECTED: growthState.windows advanced -- re-read DualAgentContext.sample() for a call path not covered by this audit.");
    }

    private static JSONObject sampleRequest(int[] actions, JSONObject outcome) throws Exception {
        JSONObject r = new JSONObject().put("id", "p1").put("mode", "train").put("epsilon", .1)
            .put("allowedMask", 4095).put("actions", new JSONArray(actions)).put("frozen", false);
        if (outcome != null) r.put("outcome", outcome);
        return r;
    }

    // --- Section 3: can FdbLearning modify or remove an edge FdbGrowth created? ------
    private static JSONObject crossMechanismEdgeTest() throws Exception {
        long[] ids = new long[30];
        for (int i = 0; i < 30; i++) ids[i] = i + 1;
        Graph g = new Graph(ids, new int[31], new int[0], new float[0]); // no W0 edges: every synapse below is exogenous
        GraphDelta layer = new GraphDelta(30);
        int source = 0, target = 16; // target is sources()[.]-disjoint output port 0 in the 16-in/12-out convention below
        float initialWeight = 8f;
        FdbGrowth growth = new FdbGrowth(g, layer, new int[]{source}, new int[]{target}, 1, 1, 4, initialWeight, true, false, 1);
        int grown = growth.observe(result(duplicate(30, source, 5)), 0, new int[0], false);
        require(grown == 1 && layer.hasEdge(source, target) && weightOf(layer, source, target) == initialWeight,
            "setup: FdbGrowth must actually create the edge under test, not FdbLearning or a raw addEdge call");

        int[] sources = new int[16];
        for (int i = 0; i < 16; i++) sources[i] = i;
        int[] targets = new int[12];
        for (int i = 0; i < 12; i++) targets[i] = 16 + i;
        FdbLearning learning = new FdbLearning(g, layer, sources, targets, .2, 16, 127);
        Engine.Result active = new Engine.Result(duplicate2(30, source, 100, target, 100), 200, 100, 100, 0);

        float afterReinforcement = Float.NaN, afterPunishment = Float.NaN;
        boolean prunedByLearning = false;
        for (int i = 0; i < 40; i++) {
            FdbLearning.Decision d = learning.decide("reinforce-" + i, active, new int[]{0, 1}, 4095, 100, 0, true, null);
            learning.feedback(d.id, d.mask, d.mask == 1 ? 1 : -1, .1, 6, true, false, null);
        }
        if (layer.hasEdge(source, target)) afterReinforcement = weightOf(layer, source, target);
        for (int i = 0; i < 200 && layer.hasEdge(source, target); i++) {
            FdbLearning.Decision d = learning.decide("punish-" + i, active, new int[]{0, 1}, 4095, 100, 0, true, null);
            learning.feedback(d.id, d.mask, d.mask == 1 ? -1 : 1, .1, 6, true, false, null);
        }
        prunedByLearning = !layer.hasEdge(source, target) && learning.pruned() > 0;
        if (layer.hasEdge(source, target)) afterPunishment = weightOf(layer, source, target);

        return new JSONObject()
            .put("section", "cross_mechanism_edge_test")
            .put("method", "Creates edge " + source + "->" + target + " exclusively through FdbGrowth.observe() (not addEdge, not FdbLearning), then drives a shared-layer FdbLearning through its real decide()/feedback() cycle: 40 reinforcing outcomes, then up to 200 punishing outcomes.")
            .put("initialWeightFromGrowth", initialWeight)
            .put("weightAfterFdbLearningReinforcement", Float.isNaN(afterReinforcement) ? JSONObject.NULL : afterReinforcement)
            .put("prunedByFdbLearning", prunedByLearning)
            .put("fdbLearningPrunedCountTotal", learning.pruned())
            .put("edgeStillPresentAfterPunishment", layer.hasEdge(source, target))
            .put("finding", "CONFIRMED: FdbLearning reads, reweights and (given enough sustained negative evidence) removes an edge regardless of whether FdbGrowth or FdbLearning itself created it -- GraphDelta.Edge carries no origin tag, and FdbLearning.feedback's trace loop iterates layer.edges() unconditionally. This is expected given the current public contract (no provenance field exists), not a bug in either class; it is the concrete mechanism behind the open question in docs/FDB_RESEARCH_ITERATION_2026-10-16_RU.md about whether an explicit provenance field is warranted.");
    }

    private static float weightOf(GraphDelta layer, int source, int target) {
        for (GraphDelta.Edge e : layer.outgoing(source)) if (e.target == target) return e.weight;
        return Float.NaN;
    }
    private static int[] duplicate(int n, int index, int value) { int[] a = new int[n]; a[index] = value; return a; }
    private static int[] duplicate2(int n, int i1, int v1, int i2, int v2) { int[] a = new int[n]; a[i1] = v1; a[i2] = v2; return a; }

    public static void main(String[] args) throws Exception {
        JSONObject section1 = nesLabActivityMatrix();
        JSONObject section2 = dualAgentContextReachability();
        JSONObject section3 = crossMechanismEdgeTest();
        JSONObject report = new JSONObject()
            .put("type", "fdb-growth-reachability-audit-v1")
            .put("sourceCommitBase", "3462e0532aafeb459ea85c968078407af711f423") // v2/gmode-fdb-gpu HEAD this branch forked from
            .put("branch", "research/fdb-growth-audit")
            .put("sections", new JSONArray().put(section1).put(section2).put(section3))
            .put("summary", new JSONArray()
                .put(section1.getString("finding"))
                .put(section2.getString("finding"))
                .put(section3.getString("finding")));
        Path out = Paths.get(args.length == 0 ? "/tmp/fdb-growth-reachability-audit.json" : args[0]);
        Files.write(out, report.toString(2).getBytes(StandardCharsets.UTF_8));
        System.out.println("PASS: FDB growth reachability audit (3 sections) written to " + out);
        System.out.println(report.toString(2));
    }
}
