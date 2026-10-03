import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Kind = "look" | "run" | "change" | "other";
type Call = { kind: Kind; what: string };
type Trip = { read: number; cached: number; stored: number; output: number; reasoning: number; modelMs: number; toolMs: number };
type Analysis = { model: string; trips: Trip[]; calls: Call[]; agentMs: number; costUsd: number };

// Dollars per million tokens at list price: Claude's from the claude-api skill in Claude Code 2.1.288.
const claudePrices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
};
// OpenAI's standard tier, short context, from developers.openai.com/api/docs/pricing.
const openaiPrices: Record<string, { input: number; cachedInput: number; cacheWrite: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
};

// Issue 1's rules, fixed before its first run and reused unchanged so both agents are bucketed the same way.
const writesFiles =
  /(^|[^>&=])[0-9]?>>?\s*(?!&|\/dev\/null)\S|\bsed\s+-i\b|\b(mv|rm|cp|tee|touch|mkdir|chmod)\s|\bgit\s+(add|commit|checkout|reset|apply|restore|stash)\b|\b(npm|pnpm|yarn)\s+(install|i|add)\b/;
const runsProject = /\b(npm|pnpm|yarn|npx|node|bun|deno|jest|vitest|mocha|pytest|make)\b/;

const bashKind = (command: string): Kind => {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''");
  if (writesFiles.test(bare)) return "change";
  return runsProject.test(bare) ? "run" : "look";
};

const jsonLines = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as T);

type ClaudeBlock = { type: string; id?: string; name?: string; tool_use_id?: string; input?: { command?: string; file_path?: string; pattern?: string } };
type ClaudeLine = {
  type: string;
  subtype?: string;
  model?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null; // external contract: Claude Code's stream-json
  message?: {
    id: string;
    usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number; cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } };
    content?: ClaudeBlock[];
  };
  event?: { type: string; message?: { id: string }; usage?: { output_tokens: number; output_tokens_details?: { thinking_tokens: number } } };
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
};

const claude = (dir: string, startedAt: number): Analysis => {
  const lines = jsonLines<ClaudeLine>(join(dir, "log.jsonl")).filter((line) => !line.parent_tool_use_id);
  const model = lines.find((line) => line.subtype === "init")?.model ?? "";
  const result = lines.find((line) => line.type === "result");
  const models = Object.keys(result?.modelUsage ?? {});
  // A second model, such as a small one for background work, would be cost the log never itemises here.
  if (models.length !== 1 || models[0] !== model) throw new Error(`${dir} used ${models.join(", ")}, not only ${model}`);

  // message_delta carries a message's final output count; the assistant lines carry a mid-stream snapshot.
  const final = new Map<string, { output: number; thinking: number }>();
  let streaming: string | undefined;
  for (const { event } of lines.filter((line) => line.type === "stream_event")) {
    if (event?.type === "message_start") streaming = event.message?.id;
    if (event?.type === "message_delta" && streaming && event.usage) {
      final.set(streaming, { output: event.usage.output_tokens, thinking: event.usage.output_tokens_details?.thinking_tokens ?? 0 });
    }
  }
  const resultAt = new Map(
    lines
      .filter((line) => line.type === "user")
      .flatMap((line) => (line.message?.content ?? []).filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id ?? "", Date.parse(line.timestamp ?? "")] as const)),
  );
  const messages = new Map<string, ClaudeLine[]>();
  for (const line of lines.filter((line) => line.type === "assistant" && line.message)) {
    messages.set(line.message!.id, [...(messages.get(line.message!.id) ?? []), line]);
  }

  const price = claudePrices[model];
  let costUsd = 0;
  let tripStart = startedAt;
  const calls = new Map<string, Call>();
  const trips = [...messages.entries()].map(([id, parts]) => {
    const usage = parts[0].message!.usage;
    const { output, thinking } = final.get(id) ?? { output: usage.output_tokens, thinking: 0 };
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? usage.cache_creation_input_tokens - write5m;
    if (price) {
      costUsd += (usage.input_tokens * price.input + usage.cache_read_input_tokens * price.cacheRead + write5m * price.cacheWrite5m + write1h * price.cacheWrite1h + output * price.output) / 1e6;
    }
    const uses = parts.flatMap((part) => part.message!.content ?? []).filter((block) => block.type === "tool_use");
    for (const block of uses) {
      const input = block.input ?? {};
      const kind: Kind =
        block.name === "Bash" ? bashKind(input.command ?? "") : ["Read", "Grep", "Glob", "LS"].includes(block.name ?? "") ? "look" : ["Edit", "MultiEdit", "Write"].includes(block.name ?? "") ? "change" : "other";
      calls.set(block.id ?? "", { kind, what: input.command ?? input.file_path ?? input.pattern ?? block.name ?? "" });
    }
    // Model time runs to the reply's last line and tool time from there to the last result, the same split as Codex's.
    const modelEnd = Math.max(...parts.map((part) => Date.parse(part.timestamp ?? "")));
    const toolsEnd = Math.max(modelEnd, ...uses.map((block) => resultAt.get(block.id ?? "") ?? modelEnd));
    const trip = {
      read: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      cached: usage.cache_read_input_tokens,
      stored: usage.cache_creation_input_tokens,
      output,
      reasoning: thinking,
      modelMs: modelEnd - tripStart,
      toolMs: toolsEnd - modelEnd,
    };
    tripStart = toolsEnd;
    return trip;
  });
  return { model, trips, calls: [...calls.values()], agentMs: result?.duration_ms ?? 0, costUsd };
};

type Usage = { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number };
type SessionLine = {
  timestamp: string;
  type: string;
  payload?: { type?: string; model?: string; input?: string; info?: { last_token_usage: Usage; total_token_usage: Usage } | null }; // external contract
};
type EventLine = { type: string; item?: { type: string } };

const codex = (dir: string, startedAt: number): Analysis => {
  const session = jsonLines<SessionLine>(join(dir, "session.jsonl"));
  const model = session.find((line) => line.type === "turn_context")?.payload?.model ?? "";

  // A token count is re-sent with rate-limit updates, so a request is one whose running total moved.
  let lastTotal = 0;
  const usages: Usage[] = [];
  for (const line of session.filter((line) => line.payload?.type === "token_count" && line.payload.info)) {
    const { total_token_usage: total, last_token_usage: last } = line.payload!.info!;
    if (total.total_tokens > lastTotal) usages.push(last);
    lastTotal = total.total_tokens;
  }

  // Codex records each reply, then its token_usage_record, then the tool output, so each record closes a model phase.
  const timings: { modelMs: number; toolMs: number }[] = [];
  let tripStart = startedAt;
  let modelEnd: number | undefined;
  let toolsEnd: number | undefined;
  const close = (): void => {
    if (!modelEnd) return;
    timings.push({ modelMs: modelEnd - tripStart, toolMs: (toolsEnd ?? modelEnd) - modelEnd });
    tripStart = toolsEnd ?? modelEnd;
    modelEnd = undefined;
    toolsEnd = undefined;
  };
  for (const line of session) {
    const at = Date.parse(line.timestamp);
    if (line.type === "token_usage_record") {
      close();
      modelEnd = at;
    }
    if (line.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(line.payload?.type ?? "") && modelEnd) toolsEnd = at;
  }
  close();
  if (timings.length !== usages.length) throw new Error(`${dir}: ${timings.length} usage records against ${usages.length} requests`);

  // The rollout holds each command as Codex wrote it, before the zsh wrapper the event log shows.
  const calls: Call[] = session
    .filter((line) => line.type === "response_item" && line.payload?.type === "custom_tool_call")
    .flatMap((line) => {
      const code = line.payload?.input ?? "";
      const commands = [...code.matchAll(/exec_command\(\{\s*cmd:\s*("(?:[^"\\]|\\.)*")/g)].map((match): Call => {
        const cmd = JSON.parse(match[1]) as string;
        return { kind: bashKind(cmd), what: cmd };
      });
      const patches = [...code.matchAll(/apply_patch\(/g)].map((): Call => ({ kind: "change", what: "apply_patch" }));
      return [...commands, ...patches];
    });
  // The event log drops a command that fails to start, so it can only hold fewer than the rollout, never more.
  const items = jsonLines<EventLine>(join(dir, "log.jsonl")).filter((line) => line.type === "item.completed" && ["command_execution", "file_change"].includes(line.item?.type ?? ""));
  if (items.length > calls.length) throw new Error(`${dir}: ${items.length} commands in the event log against ${calls.length} in the rollout`);

  const price = openaiPrices[model];
  const costUsd = price
    ? usages.reduce(
        (sum, u) =>
          sum + ((u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens) * price.input + u.cached_input_tokens * price.cachedInput + u.cache_write_input_tokens * price.cacheWrite + u.output_tokens * price.output) / 1e6,
        0,
      )
    : 0;
  const at = (type: string): number => Date.parse(session.find((line) => line.payload?.type === type)?.timestamp ?? "");
  return {
    model,
    trips: usages.map((u, i) => ({ read: u.input_tokens, cached: u.cached_input_tokens, stored: u.cache_write_input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens, ...timings[i] })),
    calls,
    agentMs: at("task_complete") - at("task_started"),
    costUsd,
  };
};

const dir = process.argv[2];
const read = (file: string): string => readFileSync(join(dir, file), "utf8");
const startedAt = Number(read("started-at.txt"));
const agent = existsSync(join(dir, "session.jsonl")) ? "codex" : "claude";
const analysis = agent === "codex" ? codex(dir, startedAt) : claude(dir, startedAt);
const count = (label: string): number => Number(read("tests-after.txt").match(new RegExp(`^ℹ ${label} (\\d+)`, "m"))?.[1] ?? Number.NaN);
const sum = (pick: (trip: Trip) => number): number => analysis.trips.reduce((total, trip) => total + pick(trip), 0);

console.log(
  JSON.stringify(
    {
      agent,
      model: analysis.model,
      version: read("version.txt").trim(),
      fixed: count("fail") === 0 && count("pass") === count("tests"),
      changedFiles: [...read("fix.diff").matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
      trips: analysis.trips.length,
      callsByKind: analysis.calls.reduce<Record<string, number>>((totals, call) => ({ ...totals, [call.kind]: (totals[call.kind] ?? 0) + 1 }), {}),
      wallMs: Number(read("ended-at.txt")) - startedAt,
      agentMs: analysis.agentMs,
      modelMs: sum((trip) => trip.modelMs),
      toolMs: sum((trip) => trip.toolMs),
      // What the first trip found already cached, which says how warm each start was.
      firstTripCached: analysis.trips[0]?.cached ?? 0,
      tokens: { read: sum((trip) => trip.read), cached: sum((trip) => trip.cached), stored: sum((trip) => trip.stored), output: sum((trip) => trip.output), reasoning: sum((trip) => trip.reasoning) },
      costUsd: analysis.costUsd,
      perTrip: analysis.trips,
      calls: analysis.calls,
    },
    undefined,
    2,
  ),
);
