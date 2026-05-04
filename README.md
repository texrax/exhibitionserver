# Exhibition Control Server — 展場中控系統

統一控制展場中所有設備的中控伺服器，包括：
- **VTube Studio** 虛擬角色（WebSocket API）
- **ESP32** WiFi LED 燈光控制（HTTP）
- **Philips Wiz** 智慧燈泡控制（UDP）
- **音訊播放**（WAV 檔案）
- **攝像頭感測**（Python 人臉偵測）
- **YoloTD 視覺辨識**（餐桌互動偵測 → VTuber 動作觸發）
- 未來可擴充任意設備

## 快速啟動

```bash
cd ExhibitionServer
pnpm install
npm start
```

開啟瀏覽器 → `http://localhost:3000`

## 架構

```
config/
  devices.json   ← 裝置定義（IP、埠號、參數）
  scenes.json    ← 場景腳本（觸發條件 → 動作序列）
src/
  app.js         ← 主程式入口
  core/
    EventBus.js      ← 事件匯流排
    DeviceManager.js ← 裝置生命週期管理
    SceneManager.js  ← 場景編排引擎
  devices/
    BaseDevice.js         ← 裝置抽象基類
    VTubeStudioDevice.js  ← VTube Studio WebSocket
    ESP32Device.js        ← ESP32 HTTP 燈光
    WizLightDevice.js     ← Philips Wiz 智慧燈泡 (UDP)
    AudioPlayerDevice.js  ← WAV 音訊播放
    CameraSensorDevice.js ← 攝像頭人臉感測
    YoloDetectorDevice.js ← YoloTD 視覺辨識整合
    index.js              ← 裝置類型註冊表
  routes/
    apiRoutes.js     ← REST API（裝置控制 + 向下相容端點）
    sceneRoutes.js   ← 場景觸發 API
public/
  index.html         ← 中控 Dashboard
```

## LLM Provider 切換（Claude / Ollama）

ChatManager 支援兩個 LLM provider，由 `config/chat.json` 的 `llm.provider` 欄位決定，可被環境變數 `LLM_PROVIDER` 覆蓋。預設使用 **Claude API**。

### 設定（`config/chat.json`）

```json
"llm": {
  "provider": "claude",
  "maxTokens": 150,
  "claude": { "model": "claude-sonnet-4-6" },
  "ollama": { "model": "qwen3.5:9b", "baseURL": "http://localhost:11434" }
}
```

### Claude（預設）

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

啟動時若 `provider=claude` 但 `ANTHROPIC_API_KEY` 未設定，伺服器會 **fail-fast 直接報錯**，不會靜默退回 Ollama。
切換模型只需修改 `chat.json` 的 `claude.model`（如 `claude-haiku-4-5-20251001`）。

### Ollama（展場無外網的離線備援）

切換方式（兩種任選）：
- 改 `chat.json` 的 `provider: "ollama"`
- 或啟動時加環境變數：`LLM_PROVIDER=ollama npm start`

需先安裝 Ollama：

**macOS：** `brew install ollama && brew services start ollama`
**Windows：** 從 [ollama.com](https://ollama.com/download) 下載安裝（背景服務 `localhost:11434`）

**拉取模型：**
```bash
ollama pull qwen3.5:9b              # 預設
ollama list                          # 驗證
```

> ⚠️ **注意**：兩個 client 共用 `sendMessage(systemPrompt, messages, maxTokens)` 介面，但 Claude 對中文角色扮演品質明顯較好；Ollama 僅作展場斷網時的緊急備援，**回覆品質下降需事前驗證可接受**。

## API 端點

### 裝置控制
| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/devices` | 所有裝置狀態 |
| GET | `/api/devices/:id` | 單一裝置狀態 |
| GET | `/api/devices/:id/actions` | 裝置支援的動作列表 |
| POST | `/api/devices/:id/execute` | 執行裝置動作 |

### 場景控制
| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/scenes` | 所有場景列表 |
| POST | `/api/scenes/:name/trigger` | 觸發場景 |
| POST | `/api/scenes/reload` | 重新載入場景設定 |

### 向下相容（原 TouchLightServer）
| Method | Path | 說明 |
|--------|------|------|
| GET | `/play/audio/:day` | 播放星期音檔 |
| POST | `/esp32/touch` | ESP32 觸摸觸發 |

### WebSocket
連線 `ws://localhost:3000/ws` 可即時接收事件與控制裝置。

## 新增裝置的方式

1. 在 `src/devices/` 建立新檔案，繼承 `BaseDevice`
2. 在 `src/devices/index.js` 加入該類別
3. 在 `config/devices.json` 加入裝置實例

範例：
```javascript
const BaseDevice = require("./BaseDevice");

class MyNewDevice extends BaseDevice {
  async init() { this._setStatus("online"); }
  async execute(action, params) { /* ... */ }
  async destroy() { await super.destroy(); }
}
module.exports = MyNewDevice;
```

## 雲端部署（免費，讓組員遠端測試）

系統支援 **雲端模式**：Dashboard 部署到免費雲端，展場電腦執行 Bridge 橋接本地設備。

```
雲端 (Render.com 免費)              展場電腦
┌──────────────────┐              ┌──────────────────┐
│  Dashboard + API │  ← WS ───→  │  Bridge 客戶端    │
│  組員瀏覽器存取   │              │  ├ VTube Studio   │
│                  │              │  ├ ESP32 燈光     │
│                  │              │  ├ 音訊播放       │
│                  │              │  └ 攝像頭         │
└──────────────────┘              └──────────────────┘
```

### 步驟一：部署到 Render.com

1. 在 ExhibitionServer 資料夾初始化 Git 並推到 GitHub：
   ```bash
   cd ExhibitionServer
   git init
   git add .
   git commit -m "initial commit"
   ```
   然後在 GitHub 上建一個 repo 並 push 上去。

2. 到 [render.com](https://render.com) 免費註冊 → **New Web Service** → 連結你的 GitHub repo

3. 設定：
   - **Build Command**: `npm install`
   - **Start Command**: `node src/app.js --cloud`
   - **Environment Variables**:
     - `CLOUD` = `1`
     - `BRIDGE_SECRET` = 自訂一組密碼（例如 `myteam2026`）

4. 點 Deploy，等幾分鐘就會拿到雲端網址：
   ```
   https://exhibitionserver.onrender.com
   ```

### 步驟二：在展場電腦執行 Bridge

在展場電腦上執行：
```bash
cd ExhibitionServer
node src/bridge.js --server wss://exhibitionserver.onrender.com --secret exhibition2026
```

或用環境變數：
```bash
set BRIDGE_SERVER=wss://exhibitionserver.onrender.com
set BRIDGE_SECRET=exhibition2026
npm run bridge
```

Bridge 會自動：
- 連上雲端 Server
- 註冊所有本地裝置（VTS、ESP32、音訊、攝像頭）
- 接收並執行雲端轉發的指令
- 斷線自動重連

### 步驟三：組員使用

組員打開瀏覽器，輸入雲端網址即可操控：
```
https://exhibitionserver.onrender.com
```

> **注意**：Render 免費方案在 15 分鐘無流量後會休眠，首次訪問可能需等 30 秒喚醒。

## Philips Wiz 智慧燈泡

透過 UDP 協議（port 38899）控制區域網路上的 Philips Wiz 燈泡，不需要雲端 API。

### Dashboard 控制

Dashboard 右側面板提供完整控制：開/關、亮度滑桿、RGB 色彩選擇、色溫快捷按鈕（暖光/自然光/冷光）、Wiz 內建場景。

### 支援動作

| Action | Params | 說明 |
|--------|--------|------|
| `on` | — | 開燈 |
| `off` | — | 關燈 |
| `setColor` | `r, g, b, brightness, speed?` | RGB 顏色 + 亮度 (10-100)，`speed` (0-100) 控制過渡速度 |
| `setTemp` | `temp, brightness` | 色溫 (2700-6500K) + 亮度 |
| `setBrightness` | `brightness` | 僅調亮度 |
| `setScene` | `sceneId` | Wiz 內建場景 (1=Ocean, 2=Romance, 4=Fireplace...) |
| `getState` | — | 查詢燈泡狀態 |
| `flickerEffect` | `r, g, b, min, max` | 不規則故障閃爍（亮度在 min~max% 間隨機跳動） |
| `stopEffect` | — | 停止閃爍效果 |

### 群組指令 `wizlight_all`

場景腳本中使用 `"device": "wizlight_all"` 可同時控制所有自動發現的 WiZ 燈泡，無需寫死個別 ID。適用於所有 WiZ 動作（`setColor`, `flickerEffect`, `off` 等）。

### 場景燈光模式

| 場景 | WiZ 燈光 | 說明 |
|------|---------|------|
| 暖心週三 (`play_day_3`) | 琥珀色 R:255 G:160 B:20，100% 亮度，平滑過渡 | 溫暖包覆感，與 ESP32 琥珀燈條同步 |
| 數位焦慮 (其他日子) | 冷紫色 R:130 G:10 B:220，亮度 30%~70% 隨機跳動 | 不規則故障閃爍，模擬系統錯誤與不安 |

> WiFi 延遲約 300ms，場景腳本中 WiZ 指令排在最前面，確保與 ESP32 燈條視覺同步。

### 設定

啟動時自動掃描區域網路上的 WiZ 燈泡（UDP 廣播），無需手動設定 IP。發現的燈泡依 MAC 排序註冊為 `wizlight_1`, `wizlight_2`...

也可在 `config/devices.json` 中手動設定：

```json
{
  "id": "wizlight",
  "type": "WizLightDevice",
  "config": {
    "ip": "192.168.1.100",
    "port": 38899,
    "timeout": 2000
  }
}
```

## VTube Studio 首次連線

1. 確認 VTube Studio 已開啟並啟用 API（設定 → Allow Plugin API access）
2. 啟動本伺服器後，VTS 會跳出授權彈窗，點選「Allow」
3. Token 會自動儲存於 `config/vts_token.txt`，後續免再授權

## VTube Studio 熱鍵映射

目前模型 (蘇菲 Live2D Ver6) 使用以下 VTS 熱鍵：

| 名稱 | 類型 | 功能 |
|------|------|------|
| 驚訝 | 表情 | 驚訝表情 |
| 生氣 | 表情 | 生氣表情 |
| 哀傷 | 表情 | 哀傷表情（劇情第三階段使用） |
| 開心(睜眼) | 表情 | 開心睜眼（星期三正解） |
| 開心(閉眼) | 表情 | 開心閉眼 |
| 更換衣服 | 表情 toggle | 進餐桌互動時換裝 |
| 吃飯手開關 | 表情 toggle | 切換手是否拿碗筷 |
| 吃青菜 | 動畫 | 吃青菜（無說話） |
| 吃完子 | 動畫 | 吃丸子（無說話） |
| 不吃 | 動畫 | 拒絕進食（無說話） |
| **說話:好吃** | 動畫 | **Ver6 新增**：吃時嘴巴會動的「好吃」反應，用於 yolo_deliver_* |
| **說話:不要吃** | 動畫 | **Ver6 新增**：拒絕時嘴巴會動，用於 yolo_reject |
| **揮手** | 動畫 | **Ver6 新增**：開場/結束揮手，用於 start 與 end_interaction |
| 待機 | 動畫 | 角色待機（注意：Ver6 已對映到「不吃_嘴巴講話」motion，待確認是否為作者預期） |
| **待機動畫變無** | 工具 | **Ver6 新增**：關閉內建呼吸待機（避免動作打架） |
| **復原待機動畫** | 工具 | **Ver6 新增**：還原呼吸待機 |
| 移除表情 | 工具 | 清除所有活躍表情 |
| 回歸原點 | 工具 | 模型回到原始位置與大小 |
| 模型重新加載 | 工具 | 重新載入模型檔 |

### 表情鏡頭控制

本系統預設已關閉 `setExpression` 時的自動鏡頭拉近，避免觸發表情時 VTS 模型位置意外移動。

在 `config/devices.json` 的 `vtubestudio` 裝置設定中加入：

```json
"zoomOnExpression": false
```

如果要單次啟用表情時強制拉近鏡頭，可在 scene action 的 `params` 中額外加入：

```json
{"file": "哀傷.exp3.json", "active": true, "fadeTime": 0.3, "zoomOnExpression": true}
```

### 表情自動互斥

系統內建表情自動互斥邏輯：透過 `setExpression` 啟用新表情時，會自動關閉先前所有活躍表情，避免表情堆疊。
也可透過 Dashboard 的「移除表情」按鈕或 `removeAllExpressions` action 手動清除所有活躍表情。

### 動畫自動取消

播放新動畫（名稱以「播放動畫」開頭的熱鍵）時，系統會自動先觸發「取消動作」熱鍵清除上一個動畫。

### setLookAt 微動作（眼神追隨）

`VTubeStudioDevice` 提供 `setLookAt` action 透過 injectParameter 同時控制頭部與雙眼，用於 AI agent 即時追隨訪客位置，**不會影響任何 hotkey/expression 狀態**。

```bash
curl -X POST http://localhost:3000/api/devices/vtubestudio/execute \
  -H "Content-Type: application/json" \
  -d '{"action":"setLookAt","params":{"x":-15,"y":0,"headTilt":3}}'
```

| 參數 | 範圍 | 說明 |
|------|------|------|
| `x` | -30 ~ 30 | 水平角度（負=左、正=右） |
| `y` | -30 ~ 30 | 垂直角度（負=下、正=上） |
| `headTilt` | -10 ~ 10 | 頭部側傾 |

呼叫一次後系統自動每 800ms resend 注入參數（VTS 規定 injected param 每秒至少 resend 一次否則被視為 lost）。要停止追隨並交回 VTS 預設追蹤：

```bash
curl -X POST http://localhost:3000/api/devices/vtubestudio/execute \
  -d '{"action":"clearLookAt","params":{}}'
```

可由 `config/devices.json` 的 vtubestudio 設定調整 keepalive 間隔：`"lookAtIntervalMs": 800`

### VTS 控制權鎖（場景保護機制）

為防止未來 AI agent 在三步驟流程（`play_day_X`、`yolo_deliver_X`、`end_interaction`）中干擾既有表情/動畫，SceneManager 維護一個 `_vtsLockMode` 狀態：

| Mode | 觸發時機 | 用途 |
|------|----------|------|
| `restricted` | 任何 scene 開始執行時 | AgentController 限制只允許白名單動作（`setLookAt`） |
| `free` | scene 結束 / 系統閒置 | AgentController 可呼叫任意 VTS action |

事件 `scene:vts_lock_changed` 會在每次切換時 publish：

```js
eventBus.on('scene:vts_lock_changed', ({ mode, scene }) => {
  // mode: 'restricted' | 'free'
});
```

可用 `sceneManager.getVtsLockMode()` 同步查詢。**此機制是後續 AI agent 功能的基礎，現階段只發出事件不執行強制限制**（限制邏輯由將實作的 `AgentController` 在 agent 端處理）。

> AI agent 即時控制 VTuber **Phase 1-7 骨架已全部完成**（mock 模式可端到端跑通）。真實視訊/音訊 (`AGENT_REAL=1`) 部分標記為 TODO 等硬體到位。詳見下方「AI Agent 即時控制」段落。

## AI Agent 即時控制

讓 AI 看訪客 + 聽訪客說話 + 即時控制 VTuber 動作。`AgentController` 接 `AIAgentDevice`（連到 `agent/` 下的 Python 服務），與既有三步驟流程互不干擾。

### 一次性安裝

```bash
cd agent && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt && cd ..
```

### 啟動

```bash
npm start
```

`start-all.js` 會自動同時啟動 Python agent + Node 中控（venv 不存在時會略過 Python，Node 仍可跑）。開 http://localhost:3000，右上角 agent badge 顯示模式 / LLM / 鎖狀態。

### 模式 + 白名單

| Mode | 觸發 | STT | VTS 動作 |
|------|------|-----|---------|
| `passive`（預設） | server 啟動 / `visitor:session_reset` | off | scene 執行中只能 `setLookAt` / `clearLookAt`，scene 結束無限制 |
| `active` | `visitor:ready_to_chat`（第四階段） | on | 同上 |

`scene:vts_lock_changed` 事件控制白名單：scene 執行中 agent 對 `vtubestudio` 的非白名單動作（`setExpression`、`triggerHotkey` 等）會被擋並 publish `agent:action_rejected`。白名單寫死在 `src/core/AgentController.js`，故意不放 config 防止 production 鬆綁。

### Claude tool use

active 模式下訪客講話 → 呼叫 Claude，三個工具：

| Tool | 對應動作 |
|------|---------|
| `look_at_visitor({x, y, headTilt?})` | `setLookAt` |
| `express_emotion({emotion})` | `setExpression` / `triggerHotkey`（依 `config/agent.json` 的 `emotionMap`，預設五個情緒：happy / sad / surprised / angry / neutral） |
| `say({text})` | publish `agent:say` 事件（暫無 TTS，可由 OBS 字幕訂閱） |

歷史超過 12 輪自動裁切，`visitor:session_reset` 時清空。Ollama provider 不支援 tool use → 對話迴圈停用，speech 會 publish 成 `agent:speech_dropped`。

### Wave 反射（不走 LLM 的即時反應）

訪客揮手 → VTuber 立刻揮手回應。**不丟 Claude，純 reflex**：訪客期待 < 500ms 視覺回應，走 LLM 端到端 2-3 秒會慢到沒感覺。

| 來源 | 觸發 | 動作 |
|------|------|------|
| `agent:gesture { type:"wave", x, y }` | Python `vision.py` 偵測（mediapipe pose: 手腕高於肩 + 1 秒內水平往復 ≥ 2 次） | `setLookAt` 朝揮手方向 + `triggerHotkey("揮手")`，5 秒 cooldown |

**白名單例外**：`triggerHotkey("揮手")` 是唯一在 scene 執行中也允許的 hotkey（迎賓動作不會干擾 scene 內部邏輯）。其他 hotkey（驚訝、生氣等）在 scene 期間仍會被擋下。要新增 hotkey 例外，改 `src/core/AgentController.js` 的 `ALLOWED_HOTKEYS_RESTRICTED`。

mock 模式下 `vision.py` 啟動 20 秒後發第一次假 wave，之後每 30 秒一次，方便驗證 wiring 不需真實鏡頭。

### Python agent

`agent/server.py` + `vision.py` + `audio.py`，跟 Node 用 `ws://localhost:9000/agent` 互通。**自動依環境變數判斷 mock/real**：

| 環境變數 | 沒設 | 有設 |
|----------|-----|-----|
| `C230_RTSP_URL` | 視覺 mock：每 5s 左右搖擺 gaze | 走 cv2 + mediapipe（`_real_loop` 待實作） |
| `DEEPGRAM_API_KEY` | 音訊 mock：`startListening` 後 2s 發「你好」 | 走 sounddevice + Deepgram（`_start_real_stt` 待實作） |

真實模式需解開 `agent/requirements.txt` 中註解的 `opencv-python`、`mediapipe`、`sounddevice`、`webrtcvad`、`deepgram-sdk` 並安裝。

### Demo endpoints（本地模式自動啟用，cloud 模式自動禁用）

不走完三步驟也能立即觸發 agent 行為展示：

```bash
curl -X POST http://localhost:3000/api/agent/_demo/force-active
sleep 1
curl -X POST http://localhost:3000/api/agent/_demo/inject-speech \
  -H "Content-Type: application/json" -d '{"text":"你好"}'
# 看 Dashboard log panel + VTuber 反應
curl -X POST http://localhost:3000/api/agent/_demo/force-passive
```

| Endpoint | 作用 |
|----------|------|
| `POST /api/agent/_demo/force-active` | agent 進 active |
| `POST /api/agent/_demo/force-passive` | agent 回 passive |
| `POST /api/agent/_demo/inject-speech` body=`{text, confidence?}` | 注入訪客語音 |
| `POST /api/agent/_demo/inject-gaze` body=`{x:0..1, y:0..1}` | 注入頭部位置 |
| `GET /api/agent/status` | 查當前 mode / lock / LLM ready |

> ⚠️ Demo endpoints 是 backdoor（任意客戶端可強制 agent 對 Claude 講話燒額度），所以雲端模式（`CLOUD=1`）會自動禁用，不需手動關閉。

## YoloTD 視覺辨識整合

系統整合了 [YoloTD](../yoloTD) 餐桌視覺辨識專案，當偵測到筷子夾菜成功送到碗裡時，自動觸發 VTuber 吃飯動畫。

### 運作方式

`YoloDetectorDevice` 每 500ms 輪詢 YoloTD 伺服器的 `GET /status` 端點，追蹤 `dining_events` 中的事件狀態。當偵測到 `deliver`（食物成功送達碗裡）事件時，發射 EventBus 事件觸發對應場景：

| 食物 | 觸發場景 | VTuber 動作 (Ver6) |
|------|---------|------------|
| vegetables（青菜） | `yolo_deliver_vegetable` | 吃飯手開關 + 說話:好吃 |
| beef（牛肉） | `yolo_deliver_beef` | 吃飯手開關 + 說話:好吃 |
| 拒絕 | `yolo_reject` | 說話:不要吃 |

> **Ver6 變更**：原本觸發無說話版的 `吃青菜` / `吃完子` / `不吃`，已替換為說話版 (`說話:好吃` / `說話:不要吃`)，搭配未來補上的「好吃」「不要吃」音檔可達成嘴巴對嘴形效果。

### 啟動方式

`npm start` 會自動啟動 YoloTD Python 伺服器作為子程序，無需手動啟動。

首次使用需安裝 Python 依賴：
```bash
cd yolo && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
```

子程序意外退出時會自動重啟。Dashboard 上可看到 `yolo_detector` 裝置狀態。

### 設定

在 `config/devices.json` 中調整 YoloDetector 參數：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `projectPath` | `./yolo` | YoloTD 專案目錄（相對於專案根目錄） |
| `pythonPath` | `projectPath/venv/bin/python` | Python 執行檔路徑 |
| `env` | `{ YOLO_PROFILE: "y11" }` | 傳給 YoloTD 的環境變數 |
| `url` | `http://localhost:8000` | YoloTD 伺服器位址 |
| `pollIntervalMs` | `500` | 輪詢間隔（毫秒） |
| `cooldownMs` | `3000` | 同類事件最短觸發間隔，防止動畫被覆蓋 |
| `startupTimeoutMs` | `15000` | 等待伺服器啟動的逾時 |

`env.CAMERA_SOURCE` 可設為手機 IP Camera 的串流 URL（如 `http://192.168.x.x:8080/video`），預設 `"0"` 為電腦攝影機。

#### YoloTD 效能調校環境變數

| 環境變數 | 預設值 | 說明 |
|----------|--------|------|
| `DETECT_EVERY_N` | `3` | 每 N 幀執行一次推論，中間幀重用上次結果 |
| `JPEG_QUALITY` | `70` | video_feed JPEG 壓縮品質 (1-100) |

### arduino ide設定
#include <WiFi.h>
#include <HTTPClient.h>
#include <FastLED.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// ==========================================
// 1. 🌐 網路設定
// ==========================================
const char* ssid = "table";        
const char* password = "00000000"; 

// 💡 筆電 IP：請務必確認 ipconfig 查到的是 31.21
const String serverURL = "http://192.168.31.47:3000"; 

// ==========================================
// 2. 🌈 燈條與感測器設定
// ==========================================
#define LED_PIN     19
#define NUM_LEDS    60
#define MAX_BRIGHT  180
CRGB leds[NUM_LEDS];
const int touchPins[7] = {32, 33, 25, 26, 4, 14, 12};
const String sceneNames[7] = {"play_day_1", "play_day_2", "play_day_3", "play_day_4", "play_day_5", "play_day_6", "play_day_7"};

String currentMode = "standby";
unsigned long lastTriggerTime = 0;
const int lockoutTime = 3000; 
WebServer server(80);

// --- 燈效引擎 (保持原樣) ---
void updateLEDs() {
  if (currentMode == "block_wave") {
    EVERY_N_MILLISECONDS(20) {
      uint8_t baseBr = beatsin8(7, 60, 140);
      for (int i = 0; i < NUM_LEDS; i++) {
        uint8_t ripple = beatsin8(11, 0, 255, 0, i * 8); 
        leds[i] = CRGB(255, 105, 0); 
        leds[i].nscale8(qadd8(baseBr, ripple / 4)); 
      }
    }
  } 
else if (currentMode == "blink") {
    // 💡 1. 調慢速度，從 15 改成 40
    EVERY_N_MILLISECONDS(80) { 
      
      // 💡 2. 讓淡出變慢（從 70 改成 30），燈光會像呼吸一樣慢慢消失
      fadeToBlackBy(leds, NUM_LEDS, 30); 
      
      // 💡 3. 降低出現機率（從 235 改成 248），讓閃爍更稀疏
      if (random8() >100) { 
        int p = random16(NUM_LEDS);
        // 💡 4. 稍微降低一點亮度，視覺更舒服
        leds[p] = CRGB(160, 0, 140); // 深紫色
        if (p > 0) leds[p-1] = CRGB(80, 80, 90); // 黯淡的灰白點
      }
    }
  }
  else {
    EVERY_N_MILLISECONDS(50) {
      uint8_t br = beatsin8(4, 30, 80);
      fill_solid(leds, NUM_LEDS, CRGB(40, 42, 50)); 
      FastLED.setBrightness(br);
    }
  }
  FastLED.show();
}

// --- 接收指令 ---
void handleSetMode() {
  if (server.hasArg("plain")) {
    StaticJsonDocument<200> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc.containsKey("mode")) {
      currentMode = doc["mode"].as<String>();
      FastLED.setBrightness(MAX_BRIGHT); 
      Serial.println(">>> 接收指令: " + currentMode);
    }
  }
  server.send(200, "application/json", "{\"status\":\"ok\"}");
}

// --- 💡 新增：向伺服器報到 IP ---
void registerToNodeJS() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverURL + "/api/devices/register"); // 報到路徑
    http.addHeader("Content-Type", "application/json");
    String payload = "{\"id\":\"esp32_main\",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
    int code = http.POST(payload);
    Serial.printf("📡 自動報到成功 | IP: %s | 回傳: %d\n", WiFi.localIP().toString().c_str(), code);
    http.end();
  }
}

void triggerNodeJS(String scene) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverURL + "/api/scenes/" + scene + "/trigger");
    http.setTimeout(2000); 
    int code = http.POST("{}");
    Serial.printf("🚀 [%s] 回傳: %d\n", scene.c_str(), code);
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, NUM_LEDS);
  for (int i = 0; i < 7; i++) pinMode(touchPins[i], INPUT);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n✅ WiFi 已連線");

  // 💡 開機立刻報到，讓 Node.js 知道我在哪
  registerToNodeJS();

  server.on("/light/mode", HTTP_POST, handleSetMode);
  server.begin();
}

void loop() {
  server.handleClient();
  updateLEDs();

  if (millis() - lastTriggerTime > lockoutTime) {
    for (int i = 0; i < 7; i++) {
      if (digitalRead(touchPins[i]) == HIGH) {
        int confirm = 0;
        for(int j=0; j<10; j++) { if(digitalRead(touchPins[i]) == HIGH) confirm++; delay(5); }
        if (confirm >= 8) { 
          Serial.print("🎯 偵測觸摸: "); Serial.println(sceneNames[i]);
          triggerNodeJS(sceneNames[i]);
          lastTriggerTime = millis(); 
          while(digitalRead(touchPins[i]) == HIGH) { server.handleClient(); updateLEDs(); delay(20); }
          break; 
        }
      }
    }
  }
}