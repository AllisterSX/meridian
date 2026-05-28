import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance", "get_lp_overview"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "get_chart_indicators", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions", "get_lp_overview"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_chart_indicators", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lessons?|learned|teach|pin|unpin|clear lessons?|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://api.minimax.io/v1",
  apiKey: process.env.LLM_API_KEY || process.env.MINIMAX_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "MiniMax-M2.5";

// Fix A: lesson ops (add_lesson, pin, unpin, clear_lesson) removed from MUTATING_TOOL_INTENTS.
// They write local state only — not on-chain — so mustUseRealTool enforcement is unnecessary
// and causes the "no tool call" error loop when MiniMax falls back from tool_choice=required to auto.
const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
// Fix B: explicit escape hatch for lesson management intents — model calls tool naturally without enforcement.
const LESSONS_MGMT_INTENTS = /\b(add lesson|pin lesson|unpin lesson|clear lesson|pin|unpin|list lessons|what did you learn)\b/i;

// Maps goal phrases to the specific tool to force when tool_choice:"required" is ignored by provider
const MUTATING_INTENT_TOOL_MAP = [
  { re: /\badd lessons?\b/i,                                     tool: "add_lesson" },
  { re: /\bpin.*lessons?\b/i,                                    tool: "pin_lesson" },
  { re: /\bunpin\b/i,                                            tool: "unpin_lesson" },
  { re: /\bclear lessons?\b/i,                                   tool: "clear_lessons" },
  { re: /\badd strategy\b/i,                                     tool: "add_strategy" },
  { re: /\bremove strategy\b/i,                                  tool: "remove_strategy" },
  { re: /\bset active strategy\b/i,                              tool: "set_active_strategy" },
  { re: /\badd smart wallet\b|\badd wallet\b|\badd.*kol\b/i,     tool: "add_smart_wallet" },
  { re: /\bremove smart wallet\b|\bremove wallet\b/i,            tool: "remove_smart_wallet" },
  { re: /\bblacklist\b|\badd to blacklist\b/i,                   tool: "add_to_blacklist" },
  { re: /\bunblock deployer\b/i,                                 tool: "unblock_deployer" },
  { re: /\bblock deployer\b/i,                                   tool: "block_deployer" },
];
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (LESSONS_MGMT_INTENTS.test(goal)) return false;  // lesson ops: local state only, no enforcement needed
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

/**
 * Convert an in-progress messages array from system-role format to user_embedded format.
 * Called only when the provider rejects the system role mid-loop.
 *
 * Key: strip ALL system-role messages (not just the leading one) — a mid-array
 * system message injected by the noToolRetry reminder path will also trigger
 * MiniMax error 2013 on the very next request.
 */
function rebuildAsUserEmbedded(currentMessages, systemPrompt, goal) {
  // Strip ALL system-role messages from the live messages array
  const withoutSystem = currentMessages.filter(m => m.role !== "system");

  if (withoutSystem.length === 0) {
    // Nothing in history yet — cold-start as user_embedded
    return [{ role: "user", content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}` }];
  }

  // Inject system prompt into the first user message so the model still has full context.
  // All subsequent messages (assistant reasoning, tool calls, tool results) are preserved.
  const result = [...withoutSystem];
  const firstUserIdx = result.findIndex(m => m.role === "user");
  if (firstUserIdx !== -1) {
    result[firstUserIdx] = {
      ...result[firstUserIdx],
      content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${result[firstUserIdx].content}`,
    };
  }
  return result;
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}
/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null, noActionPattern = null, toolArgInjector = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  let lpOverviewSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
    try {
      const { getLpOverviewSummary } = await import("./tools/lp-overview.js");
      lpOverviewSummary = await getLpOverviewSummary();
    } catch { /* lp-overview not critical */ }
  }
  // arg order: agentType, portfolio, positions, stateSummary, lessons, perfSummary,
  //            weightsSummary, decisionSummary, lpOverviewSummary
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary, lpOverviewSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // Write tools whose execution satisfies mustUseRealTool (attempt counts, not just success)
  const WRITE_TOOLS = new Set(["deploy_position", "claim_fees", "close_position", "swap_token"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const blockLoggedOnce = new Set(); // suppress repeated block log spam
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let sawWriteTool = false;
  let noToolRetryCount = 0;
  let forceToolChoice = null;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = forceToolChoice ?? ((step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto");
      forceToolChoice = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            // Rebuild from the LIVE messages array (preserves tool call history),
            // stripping ALL system-role messages so M2.7 error 2013 cannot recur.
            messages = rebuildAsUserEmbedded(messages, systemPrompt, goal);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Strip <think>...</think> before evaluating emptiness — M2.7 wraps reasoning
        // in think tags; a think-only response must not be treated as a real answer.
        const visibleContent = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

        // Hermes / some providers return null or think-only content — retry
        if (!visibleContent) {
          messages.pop(); // safe to pop — no tool_calls on this message
          emptyStreak = (emptyStreak || 0) + 1;
          if (emptyStreak >= 3) {
            log("agent", "Too many empty responses — aborting");
            return { content: "Agent received too many empty responses. Please retry.", userMessage: goal };
          }
          log("agent", "Empty response, retrying...");
          continue;
        }
        emptyStreak = 0;

        const noActionAccepted = noActionPattern ? noActionPattern.test(msg.content) : false;
        if (mustUseRealTool && !sawWriteTool && !noActionAccepted) {
          noToolRetryCount += 1;
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          // Do NOT pop the assistant message — preserves <think> reasoning context.
          // Always use role "user" for the reminder: if we are already in user_embedded
          // mode the system role is forbidden; and even in system mode a user reminder
          // is equally effective and never causes error 2013.
          const reminderText = sawToolCall
            ? "You have gathered data but did not call the required action tool. Execute the action now — do not provide a text-only answer."
            : "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.";
          messages.push({
            role: "user",
            content: `[SYSTEM REMINDER]\n${reminderText}`,
          });
          // Provider may not support tool_choice:"required" — try explicit function forcing instead
          const mappedTool = MUTATING_INTENT_TOOL_MAP.find(({ re }) => re.test(goal));
          if (mappedTool) {
            forceToolChoice = { type: "function", function: { name: mappedTool.tool } };
            log("agent", `Retry: forcing explicit tool_choice=${mappedTool.tool}`);
          }
          continue;
        }
        log("agent", "Final answer reached");
        const cleanContent = sanitizeRepetition(msg.content);
        if (cleanContent !== msg.content) log("warn", "Repetition loop detected and truncated in LLM output");
        log("agent", cleanContent);
        return { content: cleanContent, userMessage: goal };
      }
      sawToolCall = true;

      // Write tools that hit on-chain state — must not run concurrently
      const ON_CHAIN_WRITE_TOOLS = new Set(["close_position", "deploy_position", "claim_fees", "swap_token"]);

      const execOneToolCall = async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          if (!blockLoggedOnce.has(functionName)) {
            log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
            blockLoggedOnce.add(functionName);
          }
          const blockResult = { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` };
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: blockResult,
            success: false,
            step,
          });
          // Throttle: pause 5s so the LLM doesn't immediately re-attempt
          await sleep(5000);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(blockResult),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const injectedArgs = toolArgInjector ? toolArgInjector(functionName, functionArgs) : functionArgs;
        const result = await executeTool(functionName, injectedArgs);
        if (WRITE_TOOLS.has(functionName)) sawWriteTool = true;
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right.
        // Exception: safety-blocked preflight checks (result.blocked=true) do not touch chain state,
        // so the model may try the next candidate with a corrected pool_address.
        if (NO_RETRY_TOOLS.has(functionName)) {
          if (!result?.blocked) firedOnce.add(functionName);
        }
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      };

      // If multiple on-chain write tools are batched together, serialize them with
      // a delay to avoid concurrent RPC transactions causing 429 / nonce conflicts.
      const writeCount = msg.tool_calls.filter(
        (tc) => ON_CHAIN_WRITE_TOOLS.has(tc.function.name.replace(/<.*$/, "").trim())
      ).length;

      let toolResults;
      if (writeCount > 1) {
        log("agent", `Serializing ${msg.tool_calls.length} tool call(s) — ${writeCount} on-chain writes detected`);
        toolResults = [];
        for (let i = 0; i < msg.tool_calls.length; i++) {
          if (i > 0) await sleep(1500);
          toolResults.push(await execOneToolCall(msg.tool_calls[i]));
        }
      } else {
        toolResults = await Promise.all(msg.tool_calls.map(execOneToolCall));
      }

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Detect and truncate LLM repetition loops (e.g. "McMc McMc McMc..." repeated 8+ times)
function sanitizeRepetition(text) {
  if (!text) return text;
  return text.replace(/(\S{2,30})(\s+\1){8,}/g, (_, token) => `${token} [...generation loop — truncated]`);
}
