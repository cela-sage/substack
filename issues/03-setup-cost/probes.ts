import { readFileSync } from "node:fs";
import { join } from "node:path";

type Usage = { cache_read_input_tokens: number; cache_creation_input_tokens: number; input_tokens: number };
type Line = { type: string; subtype?: string; tools?: string[]; message?: { usage?: Usage } };

const runs = join(import.meta.dirname, "runs");
const variants = ["stock", "claude-md", "mcp", "both"];
const readPrice = 0.2 / 1e6;
const storePrice = 8 / 1e6;
// Issue 1's run 2 took four trips: the addition is stored on the first and read back on the other three.
const rereadsPerFix = 3;

const firstTrip = (variant: string): { read: number; stored: number; input: number; tools: number } => {
  const lines: Line[] = readFileSync(join(runs, "probes", variant, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const usage = lines.find((line) => line.type === "assistant" && line.message?.usage)?.message?.usage;
  const init = lines.find((line) => line.type === "system" && line.subtype === "init");
  if (!usage || !init) throw new Error(`${variant} has no first trip in its log`);
  return { read: usage.cache_read_input_tokens, stored: usage.cache_creation_input_tokens, input: usage.input_tokens, tools: init.tools?.length ?? 0 };
};

const cents = (usd: number): number => Math.round(usd * 100 * 1000) / 1000;
const stock = firstTrip("stock");
const baseline = stock.read + stock.stored + stock.input;

const probes = variants.map((variant) => {
  const trip = firstTrip(variant);
  const perTrip = trip.read + trip.stored + trip.input;
  const delta = perTrip - baseline;
  return {
    variant,
    tools: trip.tools,
    read: trip.read,
    stored: trip.stored,
    input: trip.input,
    perTrip,
    delta,
    centsPerReread: cents(delta * readPrice),
    centsFirstTrip: cents(delta * storePrice),
    centsPerFixArithmetic: cents(delta * storePrice + delta * rereadsPerFix * readPrice),
  };
});

const full = (run: string): { trips: number; costUsd: number; setupUsd: number } => {
  const summary = JSON.parse(readFileSync(join(runs, run, "summary.json"), "utf8"));
  return { trips: summary.trips.length, costUsd: summary.result.costUsd, setupUsd: summary.costBySource.setup };
};

console.log(JSON.stringify({ probes, fullRuns: { stock: full("stock-full"), both: full("both-full") } }, undefined, 2));
