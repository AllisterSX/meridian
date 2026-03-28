import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "update_config", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "update_config", "get_wallet_balance", "get_my_positions"]);

function getToolsForRole(agentType) {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  return tools;
}

import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getMemoryContext } from "./memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getLpOverviewSummary } from "./tools/lp-overview.js";

// Configurable LLM provider: "openrouter" (default) or "deepseek"
const provider = process.env.LLM_PROVIDER || "openrouter";
const client = new OpenAI({
  baseURL: provider === "deepseek"
    ? "https://api.deepseek.com"
    : "https://openrouter.ai/api/v1",
  apiKey: provider === "deepseek"
    ? process.env.DEEPSEEK_API_KEY
    : process.env.OPENROUTER_API_KEY,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openai/gpt-5.4-nano";

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */

// PATCH: Per-role history limits
const HISTORY_LIMITS = {
  MANAGER:  parseInt(process.env.MANAGER_HISTORY  || "4", 10),
  SCREENER: parseInt(process.env.SCREENER_HISTORY || "4", 10),
  GENERAL:  parseInt(process.env.GENERAL_HISTORY  || "8", 10),
};

// PATCH: Tool result compression
const TOOL_RESULT_LIMITS = {
  get_token_holders:        3000,
  study_top_lpers:          2000,
  discover_pools:           2500,
  get_top_candidates:       2000,
  get_wallet_positions:     1500,
  get_performance_history:  1500,
};

function compressToolResult(functionName, resultJson) {
  const limit = TOOL_RESULT_LIMITS[functionName];
  if (!limit || resultJson.length <= limit) return resultJson;
  return resultJson.slice(0, limit) + `...[truncated, ${resultJson.length - limit} chars omitted]`;
}

// PATCH: Wallet cache — avoids redundant RPC calls every cycle
let _walletCache = { data: null, ts: 0 };
async function getCachedWalletBalances() {
  const TTL_MS = 2 * 60 * 1000;
  if (_walletCache.data && (Date.now() - _walletCache.ts) < TTL_MS) return _walletCache.data;
  const data = await getWalletBalances();
  _walletCache = { data, ts: Date.now() };
  return data;
}

export function invalidateWalletCache() {
  _walletCache = { data: null, ts: 0 };
}

// PATCH: Prune session history — preserves complete tool call chains
function pruneHistory(history, maxMessages) {
  if (!Array.isArray(history) || history.length <= maxMessages) return history;
  let pruned = history.slice(-maxMessages);
  while (pruned.length > 0 && pruned[0].role === "tool") {
    pruned = pruned.slice(1);
  }
  return pruned;
}

// PATCH: Text-based tool call parser
// Converts JSON text output from models that don't support native function calling
function parseTextToolCalls(content, agentType) {
  if (!content || typeof content !== "string") return null;
  const availableTools = new Set(getToolsForRole(agentType).map(t => t.function.name));
  const found = [];

  const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = jsonBlockRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of calls) {
        const name = call.name || call.function?.name;
        const args = call.arguments || call.function?.arguments || call.parameters || {};
        if (name && availableTools.has(name)) {
          found.push({ name, args: typeof args === "string" ? JSON.parse(args) : args });
        }
      }
    } catch { /* skip */ }
  }

  const markdownToolRegex = /\*\*([a-z_]+)\*\*\s*\n```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  while ((match = markdownToolRegex.exec(content)) !== null) {
    const name = match[1];
    if (!availableTools.has(name)) continue;
    try {
      const args = JSON.parse(match[2].trim());
      if (!found.some(f => f.name === name && JSON.stringify(f.args) === JSON.stringify(args))) {
        found.push({ name, args });
      }
    } catch { /* skip */ }
  }

  if (found.length === 0) {
    const inlineRegex = /\{[^{}]*"name"\s*:\s*"([a-z_]+)"[^{}]*\}/g;
    while ((match = inlineRegex.exec(content)) !== null) {
      const name = match[1];
      if (!availableTools.has(name)) continue;
      try {
        const obj = JSON.parse(match[0]);
        const args = obj.arguments || obj.parameters || {};
        found.push({ name, args: typeof args === "string" ? JSON.parse(args) : args });
      } catch { /* skip */ }
    }
  }

  if (found.length === 0) return null;
  return found.map((f, i) => ({
    id: `text_tool_${Date.now()}_${i}`,
    type: "function",
    function: { name: f.name, arguments: JSON.stringify(f.args) },
  }));
}

// PATCH: Explicit tool-calling prompt for models that need it
const MODELS_NEEDING_TOOL_PROMPT = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-20b:extended",
]);

function needsToolCallingPrompt(model) {
  return MODELS_NEEDING_TOOL_PROMPT.has(model?.toLowerCase());
}

function buildToolCallingInstruction(agentType) {
  const roleTools = getToolsForRole(agentType).map(t => t.function.name);
  return `

TOOL CALLING INSTRUCTIONS (CRITICAL):
You MUST use tool calls (function calls) to take actions — do NOT write JSON in your response text.
Available tools for your role: ${roleTools.join(", ")}
Use the function calling mechanism directly. Do NOT write tool calls as text or markdown.
`;
}

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null) {
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getCachedWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const memoryContext = getMemoryContext();
  const signalWeights = agentType === "SCREENER" ? (getWeightsSummary() || null) : null;
  let systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, memoryContext, signalWeights);

  // Append verified on-chain LP performance from LP Agent API
  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    systemPrompt += `\n\nLP AGENT PERFORMANCE (real data from LP Agent API — use this for accurate PnL):\n${lpSummary}\n`;
  }

  const activeModel = model || (process.env.LLM_MODEL || "openai/gpt-oss-120b");
  const toolInstruction = needsToolCallingPrompt(activeModel) ? buildToolCallingInstruction(agentType) : "";
  const finalSystemPrompt = systemPrompt + toolInstruction;

  // PATCH: prune history before injecting (role-aware limit)
  const historyLimit = HISTORY_LIMITS[agentType] ?? 6;
  const prunedHistory = pruneHistory(sessionHistory, historyLimit);

  let textToolCallCount = 0;

  const messages = [
    { role: "system", content: finalSystemPrompt },
    ...prunedHistory,          // inject prior conversation turns
    { role: "user", content: goal },
  ];

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient errors; fallback model on 2nd failure
      const FALLBACK_MODEL = "openai/gpt-oss-120b";
      const RETRYABLE = new Set([402, 408, 429, 502, 503, 504, 529]);
      let response;
      let usedModel = activeModel;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools,
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: config.llm.maxTokens,
          });
          if (response.choices?.length) break;
          // Response body error (some providers return errors inline)
          const errCode = response.error?.code || response.error?.status;
          if (RETRYABLE.has(errCode)) {
            throw Object.assign(new Error(response.error?.message || `Provider error ${errCode}`), { status: errCode });
          }
          break; // non-retryable response error
        } catch (apiErr) {
          const status = apiErr.status || apiErr.statusCode;
          if (!RETRYABLE.has(status)) throw apiErr;
          // On 2nd failure, switch to fallback model
          if (attempt >= 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Primary model failed (${status}), switching to fallback ${FALLBACK_MODEL}`);
          } else {
            const wait = (attempt + 1) * 5000;
            log("agent", `Provider error ${status}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
          response = null; // ensure we retry
        }
      }

      if (!response?.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response?.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;

      // PATCH: Text tool call detection — convert JSON text output to proper tool_calls
      if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
        const parsedCalls = parseTextToolCalls(msg.content, agentType);
        if (parsedCalls && parsedCalls.length > 0) {
          textToolCallCount++;
          log("agent", `Text tool call detected (${parsedCalls.map(c => c.function.name).join(", ")}) — converting [#${textToolCallCount}]`);
          msg.tool_calls = parsedCalls;
          msg.content = null;
        }
      }

      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name;
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }

        const result = await executeTool(functionName, functionArgs);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: compressToolResult(functionName, JSON.stringify(result)),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

/**
 * Lightweight chat — uses nuggets-cached context instead of fetching from chain.
 * First attempts a single LLM call with no tools. If the LLM says it needs tools
 * (by including "[NEED_TOOLS]" in its response), escalates to full agentLoop.
 *
 * Typical response time: ~1-3s vs ~15-30s for full agentLoop.
 */
export async function lightChat(goal, sessionHistory = [], model = null) {
  const stateSummary = getStateSummary();
  const memoryContext = getMemoryContext();
  const perfSummary = getPerformanceSummary();

  // Build a lightweight context from cached/local data only — no RPC calls
  const contextParts = [
    `You are a DLMM liquidity agent assistant. Answer the user's question using the context below.`,
    `If you need LIVE on-chain data (current prices, exact PnL, execute transactions) that isn't in the context, respond with exactly "[NEED_TOOLS]" and nothing else.`,
    `For general questions, explanations, strategy discussion, or anything answerable from context — just answer directly.`,
  ];

  if (stateSummary) contextParts.push(`\nCURRENT STATE:\n${stateSummary}`);
  if (memoryContext) contextParts.push(`\nMEMORY (from nuggets):\n${memoryContext}`);
  if (perfSummary) {
    contextParts.push(`\nPERFORMANCE: ${perfSummary.total_positions_closed} closed, win rate ${perfSummary.win_rate_pct}%, avg PnL ${perfSummary.avg_pnl_pct}%`);
  }

  // Append verified on-chain LP performance from LP Agent API
  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    contextParts.push(`\nLP AGENT PERFORMANCE (verified on-chain data):\n${lpSummary}`);
  }

  const messages = [
    { role: "system", content: contextParts.join("\n") },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const FALLBACK_MODEL = "openai/gpt-oss-120b";
  const modelsToTry = [model || DEFAULT_MODEL, FALLBACK_MODEL];

  for (const tryModel of modelsToTry) {
    try {
      const response = await client.chat.completions.create({
        model: tryModel,
        messages,
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content || content.trim().includes("[NEED_TOOLS]")) {
        log("agent", "Light chat escalating to full agent loop");
        return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
      }

      log("agent", `Light chat answered directly (${tryModel})`);
      return { content, userMessage: goal };
    } catch (e) {
      const status = e.status || e.statusCode;
      if (tryModel !== FALLBACK_MODEL && (status === 402 || status === 429 || status === 502 || status === 503 || status === 504 || status === 529)) {
        log("agent", `Light chat primary failed (${status}), trying fallback ${FALLBACK_MODEL}`);
        continue;
      }
      log("agent", `Light chat failed (${e.message}), falling back to full agent loop`);
      return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
