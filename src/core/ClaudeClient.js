// Claude API 客戶端 — 透過 axios 呼叫 Anthropic Messages API

const axios = require("axios");

class ClaudeClient {
  /**
   * @param {string} apiKey  Anthropic API Key
   * @param {string} model   模型名稱
   */
  constructor(apiKey, model = "claude-sonnet-4-20250514") {
    if (!apiKey) {
      console.warn("[ClaudeClient] ⚠️ 未設定 ANTHROPIC_API_KEY，聊天功能將無法使用");
    }
    this.apiKey = apiKey;
    this.model = model;
    this._client = axios.create({
      baseURL: "https://api.anthropic.com",
      timeout: 30000,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });
  }

  /**
   * 發送對話訊息給 Claude
   * @param {string} systemPrompt  系統提示詞
   * @param {Array<{role: string, content: string}>} messages  對話歷史
   * @param {number} maxTokens  最大回覆 token 數
   * @returns {Promise<string>}  助手回覆文字
   */
  async sendMessage(systemPrompt, messages, maxTokens = 300) {
    if (!this.apiKey) {
      throw new Error("未設定 ANTHROPIC_API_KEY");
    }

    try {
      const response = await this._client.post("/v1/messages", {
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
      });

      const content = response.data.content;
      if (!content || content.length === 0) {
        throw new Error("Claude 回覆內容為空");
      }

      // 取第一個 text block
      const textBlock = content.find((b) => b.type === "text");
      if (!textBlock) {
        throw new Error("Claude 回覆中無文字內容");
      }

      return textBlock.text;
    } catch (err) {
      if (err.response) {
        const status = err.response.status;
        const errMsg = err.response.data?.error?.message || err.message;

        // Rate limit — 等 1 秒重試一次
        if (status === 429) {
          console.log("[ClaudeClient] 遭遇速率限制，1 秒後重試...");
          await new Promise((r) => setTimeout(r, 1000));
          return this.sendMessage(systemPrompt, messages, maxTokens);
        }

        throw new Error(`Claude API 錯誤 (${status}): ${errMsg}`);
      }
      throw new Error(`Claude API 連線失敗: ${err.message}`);
    }
  }
}

module.exports = ClaudeClient;