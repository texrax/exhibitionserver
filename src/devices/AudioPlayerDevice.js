// 音訊播放裝置 — 播放 WAV 音檔，含播放鎖定機制防止重疊
// 播放完畢時透過 EventBus 發送 audio:finished 事件

const path = require("path");
const { execFile } = require("child_process");
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
        return this._play(params.file, params.duration);
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

 async _play(file, duration) {
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
      const ext = path.extname(file).toLowerCase();
      if (ext === ".mp3") {
        // MP3 用 PowerShell MediaPlayer 播放
        const psScript = `
          Add-Type -AssemblyName PresentationCore
          $p = New-Object System.Windows.Media.MediaPlayer
          $p.Open([Uri]'${filePath.replace(/\\/g, "\\\\")}')
          Start-Sleep -Milliseconds 300
          $p.Play()
          while($p.Position -lt $p.NaturalDuration.TimeSpan -and $p.NaturalDuration.HasTimeSpan){ Start-Sleep -Milliseconds 200 }
          $p.Close()
        `;
        this._psProcess = execFile("powershell", ["-NoProfile", "-Command", psScript], (err) => {
          this._psProcess = null;
          if (err && !this._intentionalStop) {
            console.error(`[${this.id}] MP3 播放出錯:`, err.message);
          }
        });
      } else {
        // WAV 用 node-wav-player
        player.play({ path: filePath, sync: false }).catch(err => {
          console.error(`[${this.id}] 播放過程出錯:`, err.message);
        });
      }
    } catch (err) {
      console.error(`[${this.id}] 播放指令啟動失敗:`, err.message);
    } finally {
      const unlockMs = duration ? duration * 1000 : 1000;
      if (duration) {
        setTimeout(() => { this._stop(); }, duration * 1000);
      }
      setTimeout(() => {
        this.isPlaying = false;
        this.currentFile = null;
        this.eventBus.publish(`${this.id}:finished`, { file });
        console.log(`[${this.id}] 播放器已就緒 (解鎖)`);
      }, unlockMs + 200);
    }

    return { status: "ok" };
  }

  _stop() {
    this._intentionalStop = true;
    try { player.stop(); } catch {}
    if (this._psProcess) {
      try { this._psProcess.kill(); } catch {}
      this._psProcess = null;
    }
    this._intentionalStop = false;
    this.isPlaying = false;
    this.currentFile = null;
    this.eventBus.publish(`${this.id}:stopped`, {});
  }
}

module.exports = AudioPlayerDevice;
