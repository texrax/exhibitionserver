// Ollama 本地 LLM 客戶端 — 透過 axios 呼叫本地 Ollama API
// 介面與 ClaudeClient 完全相同，可直接替換

const axios = require("axios");

class OllamaClient {
  /**
   * @param {string} model   模型名稱（如 gemma4:e4b）
   * @param {string} baseURL Ollama 服務位址
   */
  constructor(model = "gemma4:e4b", baseURL = "http://localhost:11434") {
    this.model = model;
    this._client = axios.create({
      baseURL,
      timeout: 120000, // 本地推論可能較慢，給 2 分鐘
      headers: { "content-type": "application/json" },
    });
    console.log(`[OllamaClient] 使用模型: ${model}, 位址: ${baseURL}`);
  }

  /**
   * 發送對話訊息給本地 LLM
   * @param {string} systemPrompt  系統提示詞
   * @param {Array<{role: string, content: string}>} messages  對話歷史
   * @param {number} maxTokens  最大回覆 token 數
   * @returns {Promise<string>}  助手回覆文字
   */
  async sendMessage(systemPrompt, messages, maxTokens = 300) {
    // 組裝 Ollama 格式：system prompt 放在 messages 最前面
    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    try {
      const response = await this._client.post("/api/chat", {
        model: this.model,
        messages: ollamaMessages,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.8,
        },
      });

      const content = response.data?.message?.content;
      if (!content) {
        throw new Error("Ollama 回覆內容為空");
      }

      return content.trim();
    } catch (err) {
      if (err.response) {
        const status = err.response.status;
        const errMsg = err.response.data?.error || err.message;
        throw new Error(`Ollama API 錯誤 (${status}): ${errMsg}`);
      }
      if (err.code === "ECONNREFUSED") {
        throw new Error("Ollama 未啟動，請執行 ollama serve");
      }
      throw new Error(`Ollama 連線失敗: ${err.message}`);
    }
  }
}

module.exports = OllamaClient;