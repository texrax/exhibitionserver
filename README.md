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
| `setColor` | `r, g, b, brightness` | RGB 顏色 + 亮度 (10-100) |
| `setTemp` | `temp, brightness` | 色溫 (2700-6500K) + 亮度 |
| `setBrightness` | `brightness` | 僅調亮度 |
| `setScene` | `sceneId` | Wiz 內建場景 (1=Ocean, 2=Romance, 4=Fireplace...) |
| `getState` | — | 查詢燈泡狀態 |

### 設定

在 `config/devices.json` 中設定燈泡 IP：

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

> 可新增多組 WizLightDevice 控制不同燈泡，只要給不同 `id` 和 `ip`。

## VTube Studio 首次連線

1. 確認 VTube Studio 已開啟並啟用 API（設定 → Allow Plugin API access）
2. 啟動本伺服器後，VTS 會跳出授權彈窗，點選「Allow」
3. Token 會自動儲存於 `config/vts_token.txt`，後續免再授權

## VTube Studio 熱鍵映射

目前模型使用以下 VTS 熱鍵：

| 熱鍵 | 名稱 | 功能 |
|------|------|------|
| N1 | 驚訝 | 表情 |
| N2 | 生氣 | 表情 |
| N3 | 哀傷 | 表情 |
| N4 | 開心(睜眼) | 表情 |
| N5 | 開心(閉眼) | 表情 |
| N6 | 更換衣服 | 表情 toggle |
| N7 | 吃飯手開關 | 表情 toggle |
| N8 | 播放動畫(吃青菜) | 動畫 |
| N9 | 播放動畫(吃丸子) | 動畫 |
| N0 | 播放動畫(不吃) | 動畫 |
| F1 | 播放動畫(待機) | 動畫 |
| F2 | 移除表情 | 工具 |
| F3 | 回歸原點 | 工具 |
| F4 | 模型重新加載 | 工具 |

### 表情自動互斥

系統內建表情自動互斥邏輯：透過 `setExpression` 啟用新表情時，會自動關閉先前所有活躍表情，避免表情堆疊。
也可透過 Dashboard 的「移除表情」按鈕或 `removeAllExpressions` action 手動清除所有活躍表情。

### 動畫自動取消

播放新動畫（名稱以「播放動畫」開頭的熱鍵）時，系統會自動先觸發「取消動作」熱鍵清除上一個動畫。

## YoloTD 視覺辨識整合

系統整合了 [YoloTD](../yoloTD) 餐桌視覺辨識專案，當偵測到筷子夾菜成功送到碗裡時，自動觸發 VTuber 吃飯動畫。

### 運作方式

`YoloDetectorDevice` 每 500ms 輪詢 YoloTD 伺服器的 `GET /status` 端點，追蹤 `dining_events` 中的事件狀態。當偵測到 `deliver`（食物成功送達碗裡）事件時，發射 EventBus 事件觸發對應場景：

| 食物 | 觸發場景 | VTuber 動作 |
|------|---------|------------|
| vegetables（青菜） | `yolo_deliver_vegetable` | 吃飯手開關 + 吃青菜 |
| pork（豬肉） | `yolo_deliver_pork` | 吃飯手開關 + 吃丸子 |
| beef（牛肉） | `yolo_deliver_beef` | 吃飯手開關 + 吃丸子 |

### 啟動方式

1. 先啟動 YoloTD 伺服器：
   ```bash
   cd /path/to/yoloTD/src
   YOLO_PROFILE=y11 python server.py
   ```
2. 再啟動中控系統：
   ```bash
   npm start
   ```

Dashboard 上可看到 `yolo_detector` 裝置狀態。YoloTD 離線時裝置標記為 offline，上線後自動恢復。

### 設定

在 `config/devices.json` 中調整 YoloDetector 參數：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `url` | `http://localhost:8000` | YoloTD 伺服器位址 |
| `pollIntervalMs` | `500` | 輪詢間隔（毫秒） |
| `cooldownMs` | `3000` | 同類事件最短觸發間隔，防止動畫被覆蓋 |
| `timeout` | `3000` | HTTP 請求逾時 |

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
const String serverURL = "http://192.168.31.21:3000"; 

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
    EVERY_N_MILLISECONDS(15) {
      fadeToBlackBy(leds, NUM_LEDS, 70);
      if (random8() > 235) {
        int p = random16(NUM_LEDS);
        leds[p] = CRGB(200, 0, 180); 
        if (p > 0) leds[p-1] = CRGB(150, 150, 160); 
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