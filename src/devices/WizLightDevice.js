// WizLightDevice.js — Philips Wiz 智慧燈泡控制（UDP 協議）
const dgram = require("dgram");
const BaseDevice = require("./BaseDevice");

class WizLightDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.ip = config.ip;
    this.port = config.port || 38899;
    this.timeout = config.timeout || 2000;
    this.mac = config.mac || null;
    this.group = config.group || null;
    this.label = config.label || null;
    this.canChangeColor = config.canChangeColor !== undefined ? config.canChangeColor : true;
    this._state = {};
    this._flickerTimer = null;
  }

  async init() {
    try {
      const res = await this._send("getPilot");
      this._state = res?.result || {};
      this._setStatus("online");
    } catch (err) {
      this._setStatus("error", err.message);
      console.error(`[${this.id}] Wiz light unreachable: ${err.message}`);
    }
  }

  async execute(action, params = {}) {
    try {
      let res;
      switch (action) {
        case "on":
          res = await this._send("setState", { state: true });
          break;
        case "off":
          res = await this._send("setState", { state: false });
          break;
        case "setColor":
          res = await this._send("setPilot", {
            r: params.r || 0,
            g: params.g || 0,
            b: params.b || 0,
            dimming: params.brightness ?? 100,
            ...(params.speed != null && { speed: params.speed }),
          });
          break;
        case "flickerEffect":
          this._startFlickerEffect(params);
          res = { success: true };
          break;
        case "stopEffect":
          this._stopEffect();
          res = { success: true };
          break;
        case "setTemp":
          res = await this._send("setPilot", {
            temp: params.temp || 4000,
            dimming: params.brightness ?? 100,
          });
          break;
        case "setBrightness":
          res = await this._send("setPilot", { dimming: params.brightness ?? 100 });
          break;
        case "setScene":
          res = await this._send("setPilot", { sceneId: params.sceneId || 1 });
          break;
        case "getState":
          res = await this._send("getPilot");
          this._state = res?.result || {};
          break;
        default:
          throw new Error(`[${this.id}] Unknown action: ${action}`);
      }
      console.log(`[${this.id}] ${action} OK`);
      this._setStatus("online");
      this.eventBus.publish(`${this.id}:${action}`, { action, params, result: res });
      return res;
    } catch (err) {
      this._setStatus("error", err.message);
      console.error(`[${this.id}] ${action} failed: ${err.message}`);
      throw err;
    }
  }

  getSupportedActions() {
    return [
      { action: "on", params: {}, description: "開燈" },
      { action: "off", params: {}, description: "關燈" },
      { action: "setColor", params: { r: 255, g: 0, b: 0, brightness: 100 }, description: "設定 RGB 顏色" },
      { action: "setTemp", params: { temp: 4000, brightness: 100 }, description: "設定色溫" },
      { action: "setBrightness", params: { brightness: 100 }, description: "設定亮度" },
      { action: "setScene", params: { sceneId: 1 }, description: "設定內建場景" },
      { action: "getState", params: {}, description: "查詢燈泡狀態" },
      { action: "flickerEffect", params: { r: 130, g: 10, b: 220, min: 30, max: 70 }, description: "不規則故障閃爍" },
      { action: "stopEffect", params: {}, description: "停止閃爍效果" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      mac: this.mac,
      group: this.group,
      label: this.label,
      canChangeColor: this.canChangeColor,
      wizState: this._state,
    };
  }

  /** 不規則閃爍效果 — 遞迴 setTimeout 產生隨機延遲 */
  _startFlickerEffect({ r = 130, g = 10, b = 220, min = 30, max = 70 }) {
    this._stopEffect();
    const flicker = async () => {
      const brightness = min + Math.random() * (max - min);
      try {
        await this._send("setPilot", {
          r, g, b, dimming: Math.round(brightness),
        });
      } catch (e) { /* 閃爍失敗靜默忽略 */ }
      const nextDelay = 200 + Math.random() * 600;
      this._flickerTimer = setTimeout(flicker, nextDelay);
    };
    flicker();
  }

  _stopEffect() {
    if (this._flickerTimer) {
      clearTimeout(this._flickerTimer);
      this._flickerTimer = null;
    }
  }

  /** UDP 通訊核心 */
  _send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");
      const msg = JSON.stringify({ id: 1, method, params });

      const timer = setTimeout(() => {
        sock.close();
        reject(new Error("Wiz light timeout"));
      }, this.timeout);

      sock.send(msg, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          sock.close();
          reject(err);
        }
      });

      sock.on("message", (data) => {
        clearTimeout(timer);
        sock.close();
        try {
          resolve(JSON.parse(data.toString()));
        } catch (e) {
          reject(new Error("Invalid JSON response from Wiz light"));
        }
      });

      sock.on("error", (err) => {
        clearTimeout(timer);
        sock.close();
        reject(err);
      });
    });
  }

  async destroy() {
    this._stopEffect();
    await super.destroy();
  }

  /**
   * UDP 廣播掃描區域網路上所有 Wiz 燈泡
   * @returns {Promise<Array<{ip: string, mac: string, state: object}>>}
   */
  static discover(timeout = 3000, broadcastCount = 3) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket("udp4");
      const msg = JSON.stringify({ id: 1, method: "getPilot", params: {} });
      const found = [];

      sock.bind(() => {
        sock.setBroadcast(true);
        // 發送多次廣播，間隔 300ms，避免 UDP 丟包導致漏掃
        for (let i = 0; i < broadcastCount; i++) {
          setTimeout(() => {
            try { sock.send(msg, 38899, "255.255.255.255"); } catch {}
          }, i * 300);
        }
      });

      sock.on("message", (data, rinfo) => {
        try {
          const res = JSON.parse(data.toString());
          const mac = res.result?.mac || "unknown";
          // 用 MAC 去重，避免同一顆燈回應多次
          if (!found.some((f) => f.mac === mac)) {
            found.push({ ip: rinfo.address, mac, state: res.result || {} });
          }
        } catch {}
      });

      sock.on("error", () => { sock.close(); resolve(found); });

      setTimeout(() => {
        sock.close();
        resolve(found);
      }, timeout);
    });
  }
}

module.exports = WizLightDevice;
