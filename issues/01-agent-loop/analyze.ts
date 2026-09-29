import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Kind = "look" | "run" | "change" | "other";

type ToolInput = { command?: string; file_path?: string; pattern?: string; description?: string };

type Block = {
  type: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  tool_use_id?: string;
  is_error?: boolean | null; // external contract: Claude Code's stream-json
};

type Usage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens: number;
};

type Price = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

// Dollars per million tokens at list price, from the claude-api skill bundled with Claude Code 2.1.284.
const pricePerMillion: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type Line = {
  type: string;
  subtype?: string;
  model?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null; // external contract: Claude Code's stream-json
  message?: { id: string; usage: Usage; content?: Block[] };
  event?: { type: string; message?: { id: string }; usage?: { output_tokens: number } };
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  permission_denials?: unknown[];
  modelUsage?: Record<string, ModelUsage>;
};

type Call = Block & { name: string; input: ToolInput; issuedAt: number; result?: { at: number; isError: boolean } };
type Message = { id: string; at: number; context: number; read: number; stored: number; output: number; calls: Call[] };

// Every rule below was fixed before the first real run, so the buckets can't be tuned to fit the thesis.
const writesFiles =
  /(^|[^>&=])[0-9]?>>?\s*(?!&|\/dev\/null)\S|\bsed\s+-i\b|\b(mv|rm|cp|tee|touch|mkdir|chmod)\s|\bgit\s+(add|commit|checkout|reset|apply|restore|stash)\b|\b(npm|pnpm|yarn)\s+(install|i|add)\b/;
const runsProject = /\b(npm|pnpm|yarn|npx|node|bun|deno|jest|vitest|mocha|pytest|make)\b/;
const looks = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"];
const changes = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const bashKind = (command: string): Kind => {
  // Quoted text is data, so `node -e "a => b"` or `echo 'x > y'` never reads as a redirect.
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''");
  if (writesFiles.test(bare)) {
    return "change";
  }
  return runsProject.test(bare) ? "run" : "look";
};

const kindOf = (name: string, input: ToolInput): Kind => {
  if (name === "Bash") {
    return bashKind(input.command ?? "");
  }
  if (looks.includes(name)) {
    return "look";
  }
  return changes.includes(name) ? "change" : "other";
};

const logPath = process.argv[2];
const startedAt = Number(readFileSync(join(dirname(logPath), "started-at.txt"), "utf8"));
const lines: Line[] = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line) as Line)
  .filter((line) => !line.parent_tool_use_id);

const blocksOf = (line: Line, type: string): Block[] => (line.message?.content ?? []).filter((block) => block.type === type);

// message_delta carries a message's final output count; the assistant lines only carry a snapshot taken mid-stream.
const finalOutput = new Map<string, number>();
let streaming: string | undefined;
for (const { event } of lines.filter((line) => line.type === "stream_event")) {
  if (event?.type === "message_start") {
    streaming = event.message?.id;
  }
  if (event?.type === "message_delta" && streaming && event.usage) {
    finalOutput.set(streaming, event.usage.output_tokens);
  }
}

const results = new Map(
  lines
    .filter((line) => line.type === "user")
    .flatMap((line) =>
      blocksOf(line, "tool_result").map((block) => [block.tool_use_id ?? "", { at: Date.parse(line.timestamp ?? ""), isError: Boolean(block.is_error) }] as const),
    ),
);

// One API message is spread over several lines, one per content block, so group by id and dedupe calls by block id.
const byId = new Map<string, { id: string; usage: Usage; lines: Line[] }>();
for (const line of lines.filter((line) => line.type === "assistant" && line.message)) {
  const { id, usage } = line.message!;
  const message = byId.get(id) ?? { id, usage, lines: [] };
  byId.set(id, { ...message, lines: [...message.lines, line] });
}

const messages: Message[] = [...byId.values()].map((message) => {
  // Claude Code starts a tool as soon as its block streams in, so a parallel call's clock starts at its own line.
  const calls = [
    ...new Map(
      message.lines.flatMap((line) =>
        blocksOf(line, "tool_use").map((block) => [block.id ?? "", { ...block, issuedAt: Date.parse(line.timestamp ?? "") }] as const),
      ),
    ).values(),
  ];
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = message.usage;
  return {
    id: message.id,
    at: Math.max(...message.lines.map((line) => Date.parse(line.timestamp ?? ""))),
    context: input_tokens + cache_read_input_tokens + cache_creation_input_tokens,
    read: cache_read_input_tokens,
    stored: cache_creation_input_tokens,
    output: finalOutput.get(message.id) ?? output_tokens,
    calls: calls.map((call) => ({ ...call, name: call.name ?? "", input: call.input ?? {}, result: results.get(call.id ?? "") })),
  };
});

const baseline = messages[0]?.context ?? 0;
let previousResultAt = startedAt;
const steps = messages.flatMap((message) => {
  const spanStart = previousResultAt;
  const done = message.calls.flatMap((call) => (call.result ? [call.result.at] : []));
  previousResultAt = done.length ? Math.max(...done) : message.at;
  return message.calls.map((call) => ({
    kind: kindOf(call.name, call.input),
    name: call.name,
    what: call.input.command ?? call.input.file_path ?? call.input.pattern ?? call.input.description ?? "",
    spanMs: call.result ? call.result.at - spanStart : undefined,
    modelMs: call.issuedAt - spanStart,
    toolMs: call.result ? call.result.at - call.issuedAt : undefined,
    messageOutput: message.output,
    sharedWith: message.calls.length - 1,
    isError: call.result?.isError,
  }));
});

// Each trip runs from the previous trip's last tool result to its own last result, or to its reply when it calls none.
let tripStart = startedAt;
const trips = messages.map((message) => {
  const startMs = tripStart - startedAt;
  const done = message.calls.flatMap((call) => (call.result ? [call.result.at] : []));
  tripStart = done.length ? Math.max(...done) : message.at;
  return {
    startMs,
    endMs: tripStart - startedAt,
    calls: message.calls.map((call) => ({
      kind: kindOf(call.name, call.input),
      issuedMs: call.issuedAt - startedAt,
      doneMs: call.result ? call.result.at - startedAt : undefined,
    })),
  };
});

const tally = <T>(list: T[], key: (item: T) => string, pick: (item: T) => number): Record<string, number> =>
  list.reduce<Record<string, number>>((totals, item) => ({ ...totals, [key(item)]: (totals[key(item)] ?? 0) + pick(item) }), {});
const result = lines.find((line) => line.type === "result");
const usage = Object.values(result?.modelUsage ?? {})[0];
const model = lines.find((line) => line.subtype === "init")?.model ?? "";
const price = pricePerMillion[model];

// Counted from this session's own messages: a resumed session's result line reports the whole conversation so far.
const usages = [...byId.values()].map((message) => message.usage);
const parts = {
  input: usages.reduce((total, part) => total + part.input_tokens, 0),
  cacheRead: usages.reduce((total, part) => total + part.cache_read_input_tokens, 0),
  cacheWrite5m: usages.reduce((total, part) => total + (part.cache_creation?.ephemeral_5m_input_tokens ?? 0), 0),
  cacheWrite1h: usages.reduce((total, part) => total + (part.cache_creation?.ephemeral_1h_input_tokens ?? 0), 0),
  output: messages.reduce((total, message) => total + message.output, 0),
};
const costUsd = price && {
  input: (parts.input * price.input) / 1e6,
  cacheRead: (parts.cacheRead * price.cacheRead) / 1e6,
  cacheWrite: (parts.cacheWrite5m * price.cacheWrite5m + parts.cacheWrite1h * price.cacheWrite1h) / 1e6,
  output: (parts.output * price.output) / 1e6,
};

// Turn 1 holds only the setup, so later turns read the setup back up to its size and the project's results beyond it.
const baselineContext = messages[0]?.context ?? 0;
const writePrice = price && (parts.cacheWrite5m + parts.cacheWrite1h ? (parts.cacheWrite5m * price.cacheWrite5m + parts.cacheWrite1h * price.cacheWrite1h) / (parts.cacheWrite5m + parts.cacheWrite1h) : price.cacheWrite1h);
const setupTokens = {
  stored: messages[0]?.stored ?? 0,
  read: messages.reduce((total, message, i) => total + (i === 0 ? message.read : Math.min(message.read, baselineContext)), 0),
};
const projectTokens = {
  stored: messages.slice(1).reduce((total, message) => total + message.stored, 0),
  read: messages.slice(1).reduce((total, message) => total + Math.max(0, message.read - baselineContext), 0),
};
const costBySource = price && writePrice && {
  setup: (setupTokens.stored * writePrice + setupTokens.read * price.cacheRead) / 1e6,
  project: (projectTokens.stored * writePrice + projectTokens.read * price.cacheRead) / 1e6,
  written: (parts.output * price.output) / 1e6,
  uncached: (parts.input * price.input) / 1e6,
};

// Arithmetic, not a measurement: the same run if turn 1 had found nothing on the desk and stored the whole setup.
const costIfDeskEmpty = price && writePrice && costBySource && {
  setup: (baselineContext * writePrice + (setupTokens.read - (messages[0]?.read ?? 0)) * price.cacheRead) / 1e6,
  project: costBySource.project,
  written: costBySource.written,
  uncached: costBySource.uncached,
};

console.log(
  JSON.stringify(
    {
      model,
      checks: {
        outputFromMessages: messages.reduce((total, message) => total + message.output, 0),
        outputFromResult: usage?.outputTokens,
        costFromParts: costUsd && Object.values(costUsd).reduce((total, part) => total + part, 0),
        costReported: result?.total_cost_usd,
        reportCoversEarlierSessions: (usage?.outputTokens ?? 0) > parts.output,
        messages: messages.length,
        numTurns: result?.num_turns,
        permissionDenials: result?.permission_denials?.length ?? 0,
      },
      callsByKind: tally(steps, (step) => step.kind, () => 1),
      callsByName: tally(steps, (step) => step.name, () => 1),
      spanMsByKind: tally(steps, (step) => step.kind, (step) => step.spanMs ?? 0),
      directorSplit: {
        readGrepGlob: steps.filter((step) => ["Read", "Grep", "Glob"].includes(step.name)).length,
        editWriteBash: steps.filter((step) => ["Edit", "Write", "Bash"].includes(step.name)).length,
      },
      tokens: {
        baselinePerTurn: baseline,
        baselineResent: baseline * messages.length,
        growth: messages.reduce((total, message) => total + message.context - baseline, 0),
        readTotal: parts.input + parts.cacheRead + parts.cacheWrite5m + parts.cacheWrite1h,
        cachedTotal: parts.cacheRead,
        written: parts.output,
        parts,
        setup: setupTokens,
        project: projectTokens,
      },
      costUsd,
      costBySource,
      costIfDeskEmpty,
      perTurn: messages.map((message) => ({
        context: message.context,
        growth: message.context - baseline,
        read: message.read,
        stored: message.stored,
        output: message.output,
        tools: message.calls.map((call) => call.name),
      })),
      steps,
      trips,
      result: result && {
        subtype: result.subtype,
        durationMs: result.duration_ms,
        apiMs: result.duration_api_ms,
        costUsd: result.total_cost_usd,
      },
    },
    undefined,
    2,
  ),
);
