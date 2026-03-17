# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 指令

```bash
pnpm install       # 安裝依賴
npm start          # 本地模式啟動（直接載入裝置）
npm run dev        # 開發模式（--watch 自動重啟）
npm run start:cloud  # 雲端模式（CLOUD=1，等待 Bridge 連線）
npm run bridge     # 在展場電腦執行 Bridge 橋接客戶端
```

## 架構

系統支援兩種運作模式，由 `CLOUD=1` 環境變數或 `--cloud` 參數切換：

- **本地模式**：`app.js` 直接從 `config/devices.json` 實例化所有裝置
- **雲端模式**：`app.js` 不載入本地裝置，由 `BridgeManager` 等待展場電腦透過 WebSocket `/bridge` 端點連線，動態注入 `RemoteDevice` 代理

### 核心模組關係

```
EventBus ← 所有事件廣播中心，同時推送給 Dashboard WS 客戶端
DeviceManager ← 管理裝置生命週期，透過 device id 呼叫 execute()
SceneManager ← 讀取 config/scenes.json，依 actions 陣列依序/延遲執行裝置動作
BridgeManager ← 雲端模式專用，接收展場 Bridge 連線後把裝置包裝成 RemoteDevice 注入 DeviceManager
```

### 新增裝置

1. 在 `src/devices/` 建立繼承 `BaseDevice` 的新類別
2. 在 `src/devices/index.js` 註冊類別名稱
3. 在 `config/devices.json` 加入裝置實例設定

### WebSocket 端點

- `/ws` — Dashboard 前端即時事件（所有模式）
- `/bridge?secret=<BRIDGE_SECRET>` — 展場 Bridge 連線（雲端模式，需密鑰驗證）

### 設定檔

- `config/devices.json` — 裝置定義（ip、port、參數）
- `config/scenes.json` — 場景腳本；`actions` 陣列中可用 `{ "delay": ms }` 插入等待
- `config/vts_token.txt` — VTube Studio 授權 token（自動產生，勿覆蓋）

### 雲端部署

部署於 Render.com，設定見 `render.yaml`。
Bridge 連線指令：`node src/bridge.js --server wss://exhibitionserver.onrender.com --secret <BRIDGE_SECRET>`
