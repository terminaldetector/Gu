package org.node.flyconsole;
/** One immutable graph shared by console and NES lab; engines have separate state. */
public final class GraphCache {
    private GraphCache() { }
    public static volatile Graph current;
    public static volatile String kind = "FlyWire v783 / Shiu signed model";
}
