import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { FederationBus } from "../dist/graph/federation-bus.js";

const openGraphs = new Set<TestGraph>();
const openBuses = new Set<TestFederationBus>();

/** On-disk SQLite fixture. Production and tests share the same storage mode. */
export class TestGraph extends SqliteGraph {
  private readonly directory: string;
  private closed = false;

  constructor() {
    const directory = mkdtempSync(join(tmpdir(), "peak-test-graph-"));
    super(join(directory, "analysis.db"));
    this.directory = directory;
    openGraphs.add(this);
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    super.close();
    openGraphs.delete(this);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** On-disk federation fixture; there is no in-memory database mode. */
export class TestFederationBus extends FederationBus {
  private readonly directory: string;
  private closed = false;

  constructor() {
    const directory = mkdtempSync(join(tmpdir(), "peak-test-federation-"));
    super({ dbPath: join(directory, "federation.db") });
    this.directory = directory;
    openBuses.add(this);
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    super.close();
    openBuses.delete(this);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

afterEach(() => {
  for (const graph of [...openGraphs]) graph.close();
  for (const bus of [...openBuses]) bus.close();
});
