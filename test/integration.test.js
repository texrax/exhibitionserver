// 整合單元測試 — AgentController + ClaudeAgentClient + VTS 鎖白名單
// 跑法：node test/integration.test.js
//
// 用 mock EventBus / DeviceManager / SceneManager 隔離外部依賴，
// 涵蓋 boot smoke test 摸不到的邏輯邊界（mode 切換、節流、白名單、tool dispatch、history）

const { EventEmitter } = require("events");
const path = require("path");

const AgentController = require(path.resolve(__dirname, "../src/core/AgentController"));

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; console.log(`    ✓ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`    ✗ ${msg}`); }
}

async function describe(name, fn) {
  console.log(`\n[${name}]`);
  try { await fn(); }
  catch (err) { fail++; failures.push(`${name} threw: ${err.message}`); console.error(`    ✗ THROW: ${err.message}\n${err.stack}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.published = [];
  }
  publish(event, data = {}) {
    this.published.push({ event, data });
    this.emit(event, data);
  }
  eventsOf(name) {
    return this.published.filter((p) => p.event === name);
  }
}

class MockSceneManager {
  constructor(initialMode = "free") { this._mode = initialMode; }
  getVtsLockMode() { return this._mode; }
}

class MockDeviceManager {
  constructor() { this.calls = []; this.shouldFail = false; }
  async executeOnDevice(device, action, params) {
    this.calls.push({ device, action, params });
    if (this.shouldFail) throw new Error("mock device failure");
    return { ok: true, device, action };
  }
  callsOf(action) { return this.calls.filter((c) => c.action === action); }
}

const mockVisitorSession = { getInteractionSummary: () => ({ dayAttempts: 0, foodsDelivered: [] }) };
const mockChatManager = {};
const minimalChatConfig = { character: { name: "蘇菲", backstory: "", personality: "", culture: "" } };

function makeController(extra = {}) {
  const eb = new MockEventBus();
  const sm = new MockSceneManager(extra.initialLockMode);
  const dm = new MockDeviceManager();
  const c = new AgentController({
    eventBus: eb,
    deviceManager: dm,
    sceneManager: sm,
    visitorSession: mockVisitorSession,
    chatManager: mockChatManager,
    claudeAgentClient: extra.claudeAgentClient || null,
    chatConfig: minimalChatConfig,
    config: extra.config || {},
  });
  return { c, eb, sm, dm };
}

(async () => {
  console.log("===== AgentController 整合測試 =====");

  await describe("1. 初始狀態", async () => {
    const { c } = makeController();
    const s = c.getStatus();
    assert(s.mode === "passive", `mode=${s.mode}`);
    assert(s.vtsLockMode === "free", `vtsLockMode=${s.vtsLockMode}`);
    assert(s.llmReady === false, `llmReady=${s.llmReady}`);
    assert(s.historyTurns === 0, `historyTurns=${s.historyTurns}`);
    assert(s.turnInFlight === false, `turnInFlight=${s.turnInFlight}`);
  });

  await describe("2. visitor:ready_to_chat → mode=active 且通知 startListening", async () => {
    const { c, eb, dm } = makeController();
    eb.publish("visitor:ready_to_chat", {});
    await sleep(30);
    assert(c.getStatus().mode === "active", "mode 切到 active");
    assert(dm.callsOf("startListening").length === 1, "AIAgentDevice 收到 1 次 startListening");
    assert(eb.eventsOf("agent:mode_changed").length === 1, "publish agent:mode_changed");
  });

  await describe("3. visitor:session_reset → mode=passive、清歷史、發 stopListening", async () => {
    const { c, eb, dm } = makeController({ claudeAgentClient: { runTurn: async () => ({ text:"", toolCalls:[], stopReason:"end_turn", rawContent:[] }) } });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    c._history = [{ role: "user", content: "x" }, { role: "assistant", content: [] }];
    eb.publish("visitor:session_reset", {});
    await sleep(30);
    assert(c.getStatus().mode === "passive", "mode 回 passive");
    assert(c._history.length === 0, "history 清空");
    assert(dm.callsOf("stopListening").length === 1, "AIAgentDevice 收到 stopListening");
  });

  await describe("4. scene:vts_lock_changed 同步更新 _vtsLockMode", async () => {
    const { c, eb } = makeController();
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(10);
    assert(c.getStatus().vtsLockMode === "restricted", "鎖切到 restricted");
    eb.publish("scene:vts_lock_changed", { mode: "free" });
    await sleep(10);
    assert(c.getStatus().vtsLockMode === "free", "鎖切回 free");
  });

  await describe("5. 白名單：lock=restricted 拒絕 setExpression / triggerHotkey", async () => {
    const { c, eb, dm } = makeController({ initialLockMode: "restricted" });
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);

    const r1 = await c.executeAgentAction({ device: "vtubestudio", action: "setExpression", params: { file: "x.exp3.json" } });
    assert(r1.rejected === true, "setExpression 被拒絕");
    assert(r1.reason === "scene_lock_restricted", `reason=${r1.reason}`);

    const r2 = await c.executeAgentAction({ device: "vtubestudio", action: "triggerHotkey", params: { name: "驚訝" } });
    assert(r2.rejected === true, "triggerHotkey 被拒絕");

    assert(dm.calls.length === 0, "DeviceManager 完全沒被呼叫");
    assert(eb.eventsOf("agent:action_rejected").length === 2, "publish 兩次 agent:action_rejected");
  });

  await describe("6. 白名單：lock=restricted 放行 setLookAt / clearLookAt", async () => {
    const { c, eb, dm } = makeController();
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);

    const r1 = await c.executeAgentAction({ device: "vtubestudio", action: "setLookAt", params: { x: 0, y: 0 } });
    assert(r1.ok === true, "setLookAt 通過");
    const r2 = await c.executeAgentAction({ device: "vtubestudio", action: "clearLookAt", params: {} });
    assert(r2.ok === true, "clearLookAt 通過");
    assert(dm.callsOf("setLookAt").length === 1 && dm.callsOf("clearLookAt").length === 1, "DeviceManager 收到兩次呼叫");
  });

  await describe("7. 白名單：lock=restricted 仍允許非 vtubestudio 裝置（例如 audio）", async () => {
    const { c, eb, dm } = makeController();
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);
    const r = await c.executeAgentAction({ device: "audio", action: "play", params: { file: "x.wav" } });
    assert(r.ok === true, "audio.play 通過（非 vtubestudio 不受白名單限制）");
  });

  await describe("8. gaze → setLookAt 座標映射 + 節流", async () => {
    const { c, eb, dm } = makeController({ config: { gazeMinIntervalMs: 100 } });

    eb.publish("agent:gaze", { x: 0.5, y: 0.5 }); // 中央 → 0,0
    eb.publish("agent:gaze", { x: 0.0, y: 0.5 }); // 立即 → 應節流
    await sleep(20);
    let calls = dm.callsOf("setLookAt");
    assert(calls.length === 1, `100ms 內第二次 gaze 被節流（got ${calls.length}）`);
    assert(calls[0].params.x === 0 && calls[0].params.y === 0, `0.5,0.5 → 0,0 (got ${calls[0].params.x},${calls[0].params.y})`);

    await sleep(120);
    eb.publish("agent:gaze", { x: 1.0, y: 0.0 }); // 超過節流間隔
    await sleep(20);
    calls = dm.callsOf("setLookAt");
    assert(calls.length === 2, `100ms 後新 gaze 通過（got ${calls.length}）`);
    assert(calls[1].params.x === 30 && calls[1].params.y === 30, `1.0,0.0 → 30,30 (got ${calls[1].params.x},${calls[1].params.y})`);
  });

  await describe("9. passive 模式收到 speech 直接忽略（不呼叫 LLM）", async () => {
    let runTurnCalled = 0;
    const mockLlm = { runTurn: async () => { runTurnCalled++; return { text: "", toolCalls: [], stopReason: "end_turn", rawContent: [] }; } };
    const { eb } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("agent:speech", { text: "你好", confidence: 0.95 });
    await sleep(30);
    assert(runTurnCalled === 0, "LLM 沒被呼叫");
    assert(eb.eventsOf("agent:speech_accepted").length === 0, "沒 publish speech_accepted");
  });

  await describe("10. active 模式但無 LLM client → speech_dropped", async () => {
    const { eb } = makeController({ claudeAgentClient: null });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "你好", confidence: 0.95 });
    await sleep(30);
    const dropped = eb.eventsOf("agent:speech_dropped");
    assert(dropped.length === 1, "publish 一次 speech_dropped");
    assert(dropped[0].data.reason === "no_llm_client", `reason=${dropped[0].data.reason}`);
  });

  await describe("11. active + LLM tool use 完整迴圈：say / look_at_visitor / express_emotion", async () => {
    const mockLlm = {
      runTurn: async ({ messages }) => ({
        text: "招呼",
        toolCalls: [
          { id: "t1", name: "say", input: { text: "你好啊" } },
          { id: "t2", name: "look_at_visitor", input: { x: 10, y: 0 } },
          { id: "t3", name: "express_emotion", input: { emotion: "happy" } },
        ],
        stopReason: "tool_use",
        rawContent: [
          { type: "text", text: "招呼" },
          { type: "tool_use", id: "t1", name: "say", input: { text: "你好啊" } },
          { type: "tool_use", id: "t2", name: "look_at_visitor", input: { x: 10, y: 0 } },
          { type: "tool_use", id: "t3", name: "express_emotion", input: { emotion: "happy" } },
        ],
      }),
    };
    const { c, eb, dm } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "你好", confidence: 0.95 });
    await sleep(80);

    assert(eb.eventsOf("agent:speech_accepted").length === 1, "publish speech_accepted");
    assert(eb.eventsOf("agent:llm_turn").length === 1, "publish llm_turn");
    assert(eb.eventsOf("agent:say").length === 1, "say 工具觸發 agent:say 事件");
    assert(eb.eventsOf("agent:say")[0].data.text === "你好啊", "say text 正確");
    assert(dm.callsOf("setLookAt").length === 1, "look_at_visitor → setLookAt");
    assert(dm.callsOf("setLookAt")[0].params.x === 10, "x=10");
    assert(dm.callsOf("setExpression").length === 1, "express_emotion(happy) → setExpression");
    assert(dm.callsOf("setExpression")[0].params.file === "開心(睜眼).exp3.json", "happy → 開心(睜眼).exp3.json");
    assert(c._history.length === 3, `history 有 user + assistant + tool_results (got ${c._history.length})`);
  });

  await describe("12. lock=restricted 期間 LLM 試圖 express_emotion 被白名單擋下", async () => {
    const mockLlm = {
      runTurn: async () => ({
        text: "",
        toolCalls: [{ id: "t1", name: "express_emotion", input: { emotion: "happy" } }],
        stopReason: "tool_use",
        rawContent: [{ type: "tool_use", id: "t1", name: "express_emotion", input: { emotion: "happy" } }],
      }),
    };
    const { eb, dm } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(10);
    eb.publish("agent:speech", { text: "嗨", confidence: 0.95 });
    await sleep(80);
    assert(dm.callsOf("setExpression").length === 0, "setExpression 沒被呼叫（被白名單擋）");
    assert(eb.eventsOf("agent:action_rejected").length >= 1, "publish action_rejected");
  });

  await describe("13. 並發 speech：第二個被忽略（turnInFlight 鎖）", async () => {
    let runTurnCalled = 0;
    const mockLlm = {
      runTurn: async () => {
        runTurnCalled++;
        await sleep(50); // 模擬 LLM 處理慢
        return { text: "", toolCalls: [], stopReason: "end_turn", rawContent: [] };
      },
    };
    const { eb } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "第一句", confidence: 0.95 });
    await sleep(5); // 第一個還在 inflight
    eb.publish("agent:speech", { text: "第二句", confidence: 0.95 });
    await sleep(120); // 等第一個完成
    assert(runTurnCalled === 1, `LLM 只被呼叫 1 次（got ${runTurnCalled}）`);
  });

  await describe("14. 低信心 speech 被丟棄", async () => {
    const mockLlm = { runTurn: async () => { throw new Error("不該被呼叫"); } };
    const { eb } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "雜音", confidence: 0.3 });
    await sleep(30);
    assert(eb.eventsOf("agent:speech_accepted").length === 0, "低信心被丟棄");
  });

  await describe("15. speech 失敗時退回 history（避免下次重複）", async () => {
    const mockLlm = { runTurn: async () => { throw new Error("Claude 5xx"); } };
    const { c, eb } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "你好", confidence: 0.95 });
    await sleep(30);
    assert(c._history.length === 0, `失敗後 history 退回 (got ${c._history.length})`);
    assert(eb.eventsOf("agent:llm_error").length === 1, "publish agent:llm_error");
  });

  await describe("16. emotion=neutral → removeAllExpressions", async () => {
    const mockLlm = {
      runTurn: async () => ({
        text: "",
        toolCalls: [{ id: "t1", name: "express_emotion", input: { emotion: "neutral" } }],
        stopReason: "tool_use",
        rawContent: [{ type: "tool_use", id: "t1", name: "express_emotion", input: { emotion: "neutral" } }],
      }),
    };
    const { eb, dm } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "嗨", confidence: 0.95 });
    await sleep(80);
    assert(dm.callsOf("removeAllExpressions").length === 1, "neutral → removeAllExpressions");
  });

  await describe("18. wave gesture → 觸發 setLookAt + triggerHotkey('揮手')", async () => {
    const { eb, dm } = makeController();
    eb.publish("agent:gesture", { type: "wave", x: 0.6, y: 0.3 });
    await sleep(30);
    assert(dm.callsOf("setLookAt").length === 1, "setLookAt 被觸發（朝揮手位置）");
    const hkCalls = dm.callsOf("triggerHotkey");
    assert(hkCalls.length === 1 && hkCalls[0].params.name === "揮手", "triggerHotkey('揮手') 被觸發");
  });

  await describe("19. wave cooldown 內第二次揮手被忽略", async () => {
    const { eb, dm } = makeController({ config: { waveCooldownMs: 1000 } });
    eb.publish("agent:gesture", { type: "wave", x: 0.5, y: 0.3 });
    eb.publish("agent:gesture", { type: "wave", x: 0.5, y: 0.3 });
    await sleep(30);
    assert(dm.callsOf("triggerHotkey").length === 1, `cooldown 內第二次被忽略 (got ${dm.callsOf("triggerHotkey").length})`);
  });

  await describe("20. 白名單例外：scene 執行中「揮手」hotkey 仍可觸發", async () => {
    const { eb, dm } = makeController();
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);
    eb.publish("agent:gesture", { type: "wave", x: 0.5, y: 0.3 });
    await sleep(30);
    const hkCalls = dm.callsOf("triggerHotkey");
    assert(hkCalls.length === 1 && hkCalls[0].params.name === "揮手", "scene 期間揮手仍通過白名單");
  });

  await describe("21. 白名單嚴格：scene 執行中其他 hotkey 仍被擋", async () => {
    const { eb, dm } = makeController();
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);
    const r = await dm; // placeholder
    // 直接呼叫 executeAgentAction
    const { c } = makeController({ initialLockMode: "restricted" });
    eb.publish("scene:vts_lock_changed", { mode: "restricted" });
    await sleep(5);
    const result = await c.executeAgentAction({
      device: "vtubestudio",
      action: "triggerHotkey",
      params: { name: "驚訝" },
    });
    assert(result.rejected === true, "「驚訝」hotkey 仍被白名單擋");
  });

  await describe("17. tool dispatch 對未知 tool 回 error 不 crash", async () => {
    const mockLlm = {
      runTurn: async () => ({
        text: "",
        toolCalls: [{ id: "t1", name: "fake_tool", input: {} }],
        stopReason: "tool_use",
        rawContent: [{ type: "tool_use", id: "t1", name: "fake_tool", input: {} }],
      }),
    };
    const { c, eb } = makeController({ claudeAgentClient: mockLlm });
    eb.publish("visitor:ready_to_chat", {});
    await sleep(10);
    eb.publish("agent:speech", { text: "嗨", confidence: 0.95 });
    await sleep(80);
    assert(eb.eventsOf("agent:llm_error").length === 0, "未知 tool 不被視為 error，graceful 回傳");
    assert(c._history.length === 3, "tool_results 仍寫進 history");
  });

  console.log("\n=========================================");
  console.log(`✓ ${pass} passed`);
  console.log(`✗ ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log("=========================================\n");
  process.exit(fail > 0 ? 1 : 0);
})();
