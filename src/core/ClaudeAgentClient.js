// Claude Agent Client — 專為 AI Agent tool use 設計的 Anthropic SDK 包裝
//
// 與 ClaudeClient.js 區別：
//   ClaudeClient    → 純文字往返，給 ChatManager 跑 APP 文字對話
//   ClaudeAgentClient → 結構化 tool use，給 AgentController 跑語音對話迴圈
//
// 第三方依賴：@anthropic-ai/sdk

const Anthropic = require("@anthropic-ai/sdk");

class ClaudeAgentClient {
  /**
   * @param {string} apiKey
   * @param {object} [opts]
   * @param {string} [opts.model]
   */
  constructor(apiKey, { model = "claude-sonnet-4-6" } = {}) {
    if (!apiKey) {
      throw new Error("ClaudeAgentClient: apiKey 必填");
    }
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /**
   * 跑一輪 tool use
   * @param {object} args
   * @param {string} args.systemPrompt
   * @param {Array} args.messages     對話歷史（含 user/assistant turns，assistant turn 的 content 須為原始 array）
   * @param {Array} args.tools        Anthropic tool schemas
   * @param {number} [args.maxTokens=400]
   * @param {number} [args.temperature=0.8]
   * @returns {Promise<{text:string, toolCalls:Array<{id,name,input}>, stopReason:string, rawContent:Array}>}
   */
  async runTurn({ systemPrompt, messages, tools, maxTokens = 400, temperature = 0.8 }) {
    if (!systemPrompt) throw new Error("runTurn: systemPrompt 必填");
    if (!Array.isArray(messages)) throw new Error("runTurn: messages 必填");
    if (!Array.isArray(tools)) throw new Error("runTurn: tools 必填");

    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        tools,
        messages,
      });
    } catch (err) {
      // 429 rate limit → 等 1 秒重試一次
      if (err?.status === 429) {
        console.log("[ClaudeAgentClient] 遭遇速率限制，1 秒後重試...");
        await new Promise((r) => setTimeout(r, 1000));
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          tools,
          messages,
        });
      } else {
        throw new Error(`Claude tool use 失敗: ${err.message}`);
      }
    }

    const textParts = [];
    const toolCalls = [];
    for (const block of response.content || []) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    return {
      text: textParts.join("").trim(),
      toolCalls,
      stopReason: response.stop_reason,
      // rawContent 是給 caller 把整段 assistant turn 加回 history 用（保留 tool_use block）
      rawContent: response.content,
    };
  }
}

module.exports = ClaudeAgentClient;
