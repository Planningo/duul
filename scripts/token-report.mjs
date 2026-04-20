#!/usr/bin/env node
/**
 * Combined token usage report.
 *
 * Aggregates two sources:
 *   1. Claude Code session JSONL (~/.claude/projects/<encoded-cwd>/*.jsonl)
 *      — main agent + subagent (sidechain) tokens per model
 *   2. DUUL reviewer log (~/.duul/usage.jsonl or $DUUL_USAGE_LOG)
 *      — OpenAI/Anthropic/Google reviewer tokens per tool
 *
 * Usage:
 *   node scripts/token-report.mjs [--project <abs-path>] [--since <ISO>] [--json]
 *
 * Defaults: --project = cwd, --since = 24h ago.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_PRICING = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  'claude-3.5-sonnet': { input: 3, output: 15 },
  'claude-3.5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

function priceFor(model) {
  if (!model) return null;
  let best = null;
  let bestLen = 0;
  for (const [key, val] of Object.entries(CLAUDE_PRICING)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = val;
      bestLen = key.length;
    }
  }
  return best;
}

function claudeCost(usage, model) {
  const p = priceFor(model);
  if (!p) return null;
  const input = usage.input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const inputCost = ((input + cacheCreate * 1.25 + cacheRead * 0.1) * p.input) / 1_000_000;
  const outputCost = (output * p.output) / 1_000_000;
  return inputCost + outputCost;
}

const HELP = `duul-tokens — combined Claude Code + DUUL reviewer token report

Usage: duul-tokens [options]

Options:
  --project <abs-path>  Which Claude Code project to read (default: cwd)
  --since <ISO date>    Start of window (default: 24h ago)
  --all-time            Include all history
  --plan <pro|max5|max20>  Show utilization vs plan caps (or env DUUL_PLAN)
  --json                Output raw JSON instead of text
  -h, --help            Show this message

Env:
  DUUL_USAGE_LOG        Override reviewer log path (default ~/.duul/usage.jsonl)
  DUUL_PLAN             Default --plan
  DUUL_PLAN_CAPS_JSON   Override cap estimates, e.g. '{"max5":{"per5h":220000,"weekly":3000000}}'
`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { project: process.cwd(), since: null, json: false, plan: process.env.DUUL_PLAN ?? null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (args[i] === '--project') opts.project = args[++i];
    else if (args[i] === '--since') opts.since = new Date(args[++i]).toISOString();
    else if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--all-time') opts.since = new Date(0).toISOString();
    else if (args[i] === '--plan') opts.plan = args[++i];
  }
  if (!opts.since) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    opts.since = d.toISOString();
  }
  return opts;
}

// Community-reported per-5h-window token allocations (NOT official Anthropic numbers).
// Override with DUUL_PLAN_CAPS_JSON env: '{"pro":{"per5h":44000,"weekly":900000}}'
const DEFAULT_PLAN_CAPS = {
  pro:   { per5h: 44_000,  weekly: 900_000 },     // ~44k/5h, weekly cap roughly half of theoretical max
  max5:  { per5h: 220_000, weekly: 4_500_000 },
  max20: { per5h: 880_000, weekly: 18_000_000 },
};

function getPlanCaps(plan) {
  if (!plan) return null;
  const custom = process.env.DUUL_PLAN_CAPS_JSON;
  const table = custom ? { ...DEFAULT_PLAN_CAPS, ...JSON.parse(custom) } : DEFAULT_PLAN_CAPS;
  return table[plan] ?? null;
}

function encodeProject(absPath) {
  return absPath.replace(/[\/]/g, '-');
}

function* readJsonl(path) {
  const text = readFileSync(path, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip malformed lines
    }
  }
}

function accumulate(bucket, model, usage) {
  const acc =
    bucket[model] ??
    (bucket[model] = {
      input: 0,
      cache_creation: 0,
      cache_read: 0,
      output: 0,
      messages: 0,
      cost: 0,
    });
  acc.input += usage.input_tokens ?? 0;
  acc.cache_creation += usage.cache_creation_input_tokens ?? 0;
  acc.cache_read += usage.cache_read_input_tokens ?? 0;
  acc.output += usage.output_tokens ?? 0;
  acc.messages += 1;
  const c = claudeCost(usage, model);
  if (c != null) acc.cost += c;
}

function aggregateClaudeSessions(projectPath, sinceIso) {
  const dir = join(homedir(), '.claude', 'projects', encodeProject(projectPath));
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { main: {}, subagents: {}, sessionCount: 0, missing: true, dir };
  }

  const main = {};
  const subagents = {}; // { agentType: { model: {tokens...} } }
  let sessionCount = 0;

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const full = join(dir, ent.name);
    const mtime = statSync(full).mtime.toISOString();
    if (mtime < sinceIso) continue;
    sessionCount++;
    for (const entry of readJsonl(full)) {
      if (entry.type !== 'assistant') continue;
      const msg = entry.message;
      if (!msg || !msg.usage) continue;
      if (entry.timestamp && entry.timestamp < sinceIso) continue;
      accumulate(main, msg.model ?? 'unknown', msg.usage);
    }

    // Subagent transcripts: <session>/subagents/agent-*.jsonl
    const sessionId = ent.name.replace(/\.jsonl$/, '');
    const subDir = join(dir, sessionId, 'subagents');
    let subFiles;
    try {
      subFiles = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const f of subFiles) {
      if (!f.endsWith('.jsonl')) continue;
      const agentId = f.replace(/\.jsonl$/, '');
      const metaPath = join(subDir, `${agentId}.meta.json`);
      let agentType = 'unknown';
      try {
        agentType = JSON.parse(readFileSync(metaPath, 'utf-8')).agentType ?? 'unknown';
      } catch {}
      const bucket = subagents[agentType] ?? (subagents[agentType] = {});
      for (const e2 of readJsonl(join(subDir, f))) {
        if (e2.type !== 'assistant') continue;
        const m = e2.message;
        if (!m || !m.usage) continue;
        if (e2.timestamp && e2.timestamp < sinceIso) continue;
        accumulate(bucket, m.model ?? 'unknown', m.usage);
      }
    }
  }
  return { main, subagents, sessionCount, missing: false, dir };
}

function aggregateReviewerLog(sinceIso) {
  const path = process.env.DUUL_USAGE_LOG ?? join(homedir(), '.duul', 'usage.jsonl');
  const byTool = {};
  let entryCount = 0;
  try {
    for (const entry of readJsonl(path)) {
      if (entry.timestamp < sinceIso) continue;
      entryCount++;
      const tool = entry.tool;
      const u = entry.usage ?? {};
      const acc =
        byTool[tool] ??
        (byTool[tool] = {
          input: 0,
          output: 0,
          total: 0,
          cache_read: 0,
          cache_write: 0,
          calls: 0,
          cost: 0,
          model: u.model,
          provider: u.provider,
        });
      acc.input += u.input_tokens ?? 0;
      acc.output += u.output_tokens ?? 0;
      acc.total += u.total_tokens ?? 0;
      acc.cache_read += u.cached_input_tokens ?? 0;
      acc.cache_write += u.cache_creation_input_tokens ?? 0;
      acc.calls += 1;
      acc.cost += u.estimated_cost_usd ?? 0;
    }
  } catch {
    return { byTool: {}, entryCount: 0, missing: true, path };
  }
  return { byTool, entryCount, missing: false, path };
}

function fmt(n) {
  return n.toLocaleString();
}

function money(n) {
  return `$${n.toFixed(4)}`;
}

function totalsForBucket(bucket) {
  let raw = 0, billable = 0, msgs = 0, cost = 0;
  for (const a of Object.values(bucket)) {
    raw += a.input + a.cache_creation + a.cache_read + a.output;
    // "Billable" against subscription windows is unofficial; use input + cache_creation + output
    // (cache reads are heavily discounted but still count toward context). Treat as upper bound.
    billable += a.input + a.cache_creation + a.cache_read + a.output;
    msgs += a.messages;
    cost += a.cost;
  }
  return { raw, billable, msgs, cost };
}

function printText(opts, claude, reviewer) {
  console.log(`\nDUUL token report`);
  console.log(`  project: ${opts.project}`);
  console.log(`  since:   ${opts.since}`);
  if (opts.plan) console.log(`  plan:    ${opts.plan}`);
  console.log();

  console.log(`Claude Code (${claude.sessionCount} session file(s))`);
  if (claude.missing) {
    console.log(`  (no Claude Code logs at ${claude.dir})\n`);
  } else {
    const sections = [['Main agent', claude.main]];
    for (const [agentType, bucket] of Object.entries(claude.subagents)) {
      sections.push([`Subagent: ${agentType}`, bucket]);
    }
    let totalCost = 0, totalMsgs = 0, totalBillable = 0;
    for (const [label, bucket] of sections) {
      const models = Object.keys(bucket);
      if (models.length === 0) {
        console.log(`  ${label}: (none)`);
        continue;
      }
      console.log(`  ${label}:`);
      for (const m of models) {
        const a = bucket[m];
        totalCost += a.cost;
        const perMsg = a.messages > 0 ? Math.round((a.input + a.cache_creation + a.cache_read + a.output) / a.messages) : 0;
        console.log(
          `    ${m}  msgs=${a.messages}  in=${fmt(a.input)}  cache_c=${fmt(a.cache_creation)}  cache_r=${fmt(a.cache_read)}  out=${fmt(a.output)}  avg/msg=${fmt(perMsg)}  ~${money(a.cost)}`,
        );
      }
      const t = totalsForBucket(bucket);
      totalMsgs += t.msgs;
      totalBillable += t.billable;
    }
    console.log(`  Claude total ≈ ${money(totalCost)}  msgs=${totalMsgs}  tokens=${fmt(totalBillable)}`);
    if (totalMsgs > 0) {
      console.log(`  Avg per request: ${fmt(Math.round(totalBillable / totalMsgs))} tokens, ${money(totalCost / totalMsgs)}`);
    }

    // Plan utilization
    const caps = getPlanCaps(opts.plan);
    if (opts.plan && !caps) {
      console.log(`  (unknown plan "${opts.plan}" — try: pro, max5, max20)`);
    } else if (caps) {
      const winPct = ((totalBillable / caps.per5h) * 100).toFixed(1);
      const weekPct = ((totalBillable / caps.weekly) * 100).toFixed(1);
      const perReqWinPct = totalMsgs > 0 ? ((totalBillable / totalMsgs / caps.per5h) * 100).toFixed(2) : '0';
      console.log(`  Plan utilization (${opts.plan}, community estimates — NOT official):`);
      console.log(`    vs 5h window cap (${fmt(caps.per5h)}):  ${winPct}%`);
      console.log(`    vs weekly est. cap (${fmt(caps.weekly)}): ${weekPct}%`);
      console.log(`    avg request consumes ~${perReqWinPct}% of one 5h window`);
    }
    console.log();
  }

  console.log(`Reviewer (DUUL MCP) — ${reviewer.entryCount} entries`);
  if (reviewer.missing) {
    console.log(`  (no reviewer log at ${reviewer.path} — set DUUL_DEBUG_TOKEN=1 to enable)\n`);
  } else if (reviewer.entryCount === 0) {
    console.log(`  (no entries in window)\n`);
  } else {
    let totalCost = 0, totalCalls = 0, totalTokens = 0, totalCacheRead = 0, totalCacheWrite = 0;
    for (const [tool, a] of Object.entries(reviewer.byTool)) {
      totalCost += a.cost;
      totalCalls += a.calls;
      totalTokens += a.input + a.output;
      totalCacheRead += a.cache_read;
      totalCacheWrite += a.cache_write;
      const avgTok = a.calls > 0 ? Math.round((a.input + a.output) / a.calls) : 0;
      const avgCost = a.calls > 0 ? a.cost / a.calls : 0;
      const cacheStr =
        a.cache_read || a.cache_write
          ? `  cache_r=${fmt(a.cache_read)} cache_w=${fmt(a.cache_write)}`
          : '';
      console.log(
        `  ${tool}  calls=${a.calls}  model=${a.model ?? '?'}  in=${fmt(a.input)}  out=${fmt(a.output)}${cacheStr}  avg/call=${fmt(avgTok)} tok ${money(avgCost)}  total ${money(a.cost)}`,
      );
    }
    console.log(`  Reviewer total ≈ ${money(totalCost)}  calls=${totalCalls}  tokens=${fmt(totalTokens)}`);
    if (totalCacheRead || totalCacheWrite) {
      const hitRate = totalTokens > 0 ? ((totalCacheRead / totalTokens) * 100).toFixed(1) : '0';
      console.log(`  Cache: read=${fmt(totalCacheRead)}  write=${fmt(totalCacheWrite)}  hit-rate=${hitRate}%`);
    }
    if (totalCalls > 0) {
      console.log(`  Avg per call: ${fmt(Math.round(totalTokens / totalCalls))} tokens, ${money(totalCost / totalCalls)}`);
    }
    console.log();
  }
}

const opts = parseArgs();
const claude = aggregateClaudeSessions(opts.project, opts.since);
const reviewer = aggregateReviewerLog(opts.since);

if (opts.json) {
  console.log(JSON.stringify({ opts, claude, reviewer }, null, 2));
} else {
  printText(opts, claude, reviewer);
}
