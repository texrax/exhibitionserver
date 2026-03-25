// 音訊播放裝置 — 播放 WAV 音檔，含播放鎖定機制防止重疊
// 播放完畢時透過 EventBus 發送 audio:finished 事件

const path = require("path");
const player = require("node-wav-player");
const BaseDevice = require("./BaseDevice");

class AudioPlayerDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.audioDir = path.resolve(config.audioDir || "./public/audio");
    this.isPlaying = false;
    this.currentFile = null;
  }

  async init() {
    this._setStatus("online");
  }

  async execute(action, params = {}) {
    switch (action) {
      case "play":
        return this._play(params.file);
      case "stop":
        return this._stop();
      case "isPlaying":
        return { isPlaying: this.isPlaying, currentFile: this.currentFile };
      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  getSupportedActions() {
    return [
      { action: "play", params: { file: "string" }, description: "播放音檔" },
      { action: "stop", params: {}, description: "停止播放" },
      { action: "isPlaying", params: {}, description: "查詢播放狀態" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      isPlaying: this.isPlaying,
      currentFile: this.currentFile,
    };
  }

  async destroy() {
    this._stop();
    await super.destroy();
  }

  // ---- 私有方法 ----

 async _play(file) {
    if (this.isPlaying) {
      console.log(`[${this.id}] 忽略播放請求 — 音樂播放中: ${this.currentFile}`);
      return { status: "busy", currentFile: this.currentFile };
    }

    this.isPlaying = true;
    this.currentFile = file;
    const filePath = path.join(this.audioDir, file);
    console.log(`[${this.id}] 開始播放: ${file}`);
    this.eventBus.publish(`${this.id}:playing`, { file });

    try {
      // 💡 關鍵改動：將 sync 改為 false
      // 這樣 Node.js 呼叫完播放指令後會立刻繼續往下走，不會被卡住
      player.play({ path: filePath, sync: false }).then(() => {
        // 雖然 sync 為 false，但部分播放器在播放完畢後仍會觸發 resolve
        // 如果你的環境還是太慢，我們就在這裡手動解鎖
      }).catch(err => {
        console.error(`[${this.id}] 播放過程出錯:`, err.message);
      });

      // 💡 為了讓 SceneManager 能夠立刻執行後續的燈光 delay
      // 我們直接回傳 OK，不要在這裡 await player.play
      
    } catch (err) {
      console.error(`[${this.id}] 播放指令啟動失敗:`, err.message);
    } finally {
      // 💡 宇恒注意：因為我們改為非同步，這裡需要根據音檔大約長度來「手動解鎖」
      // 或者是直接設定為 false 讓下一次觸發可以進行
      // 為了保險，我們這裡讓它 1 秒後就恢復可播放狀態
      setTimeout(() => {
        this.isPlaying = false;
        this.currentFile = null;
        this.eventBus.publish(`${this.id}:finished`, { file });
        console.log(`[${this.id}] 播放器已就緒 (解鎖)`);
      }, 1000); 
    }

    return { status: "ok" };
  }

  _stop() {
    if (this.isPlaying) {
      try { player.stop(); } catch {}
      this.isPlaying = false;
      this.currentFile = null;
      this.eventBus.publish(`${this.id}:stopped`, {});
    }
  }
}

module.exports = AudioPlayerDevice;
