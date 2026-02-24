# Exhibition Control Server — 展場中控系統

統一控制展場中所有設備的中控伺服器，包括：
- **VTube Studio** 虛擬角色（WebSocket API）
- **ESP32** WiFi LED 燈光控制（HTTP）
- **音訊播放**（WAV 檔案）
- **攝像頭感測**（Python 人臉偵測）
- 未來可擴充任意設備

## 快速啟動

```bash
cd ExhibitionServer
npm install
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
    AudioPlayerDevice.js  ← WAV 音訊播放
    CameraSensorDevice.js ← 攝像頭人臉感測
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

## VTube Studio 首次連線

1. 確認 VTube Studio 已開啟並啟用 API（設定 → Allow Plugin API access）
2. 啟動本伺服器後，VTS 會跳出授權彈窗，點選「Allow」
3. Token 會自動儲存於 `config/vts_token.txt`，後續免再授權
