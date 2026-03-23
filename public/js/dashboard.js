// 展場中控 Dashboard — 前端 WebSocket 即時狀態與操控

(function () {
  let ws = null;
  let reconnectTimer = null;
  const MAX_LOG_ENTRIES = 100;

  // DOM 元素快取
  const connDot = document.getElementById("connDot");
  const connText = document.getElementById("connText");
  const deviceList = document.getElementById("deviceList");
  const sceneContainer = document.getElementById("sceneContainer");
  const logEntries = document.getElementById("logEntries");
  const toast = document.getElementById("toast");

  // ==================================================
  //  WebSocket 連線
  // ==================================================

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      connDot.classList.add("connected");
      connText.textContent = "Connected";
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = () => {
      connDot.classList.remove("connected");
      connText.textContent = "Disconnected";
      scheduleReconnect();
    };

    ws.onerror = () => {};

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  const bridgeDot = document.getElementById("bridgeDot");
  const bridgeText = document.getElementById("bridgeText");
  let isCloudMode = false;

  function updateBridgeUI(connected) {
    if (!isCloudMode) return;
    bridgeDot.style.display = "";
    bridgeText.style.display = "";
    if (connected) {
      bridgeDot.classList.add("connected");
      bridgeText.textContent = "Bridge OK";
    } else {
      bridgeDot.classList.remove("connected");
      bridgeText.textContent = "Bridge OFF";
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "init":
        renderDevices(msg.payload.devices);
        renderScenes(msg.payload.scenes);
        renderLogBatch(msg.payload.events);
        if (msg.payload.cloudMode) {
          isCloudMode = true;
          updateBridgeUI(msg.payload.bridgeConnected);
        }
        break;
      case "event":
        appendLog(msg.payload);
        if (msg.payload.event === "bridge:connected") updateBridgeUI(true);
        if (msg.payload.event === "bridge:disconnected") updateBridgeUI(false);
        if (msg.payload.event === "bridge:devicesRegistered") requestStatus();
        if (msg.payload.event.endsWith(":status")) {
          requestStatus();
          if (msg.payload.event === "wizlight:status") updateWizStatus(msg.payload.data);
        }
        break;
      case "status":
        renderDevices(msg.payload.devices);
        renderScenes(msg.payload.scenes);
        break;
    }
  }

  function requestStatus() {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "getStatus" }));
    }
  }

  // ==================================================
  //  裝置渲染
  // ==================================================

  function renderDevices(devices) {
    if (devices.length === 0 && isCloudMode) {
      deviceList.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">等待展場 Bridge 連線...</div>';
      return;
    }
    deviceList.innerHTML = devices.map((d) => `
      <div class="device-card" data-id="${d.id}">
        <div class="device-header">
          <span class="device-name">${d.id}</span>
          <span class="status-badge ${d.status}">${d.status}</span>
        </div>
        <div class="device-type">${d.type}${d.remote ? ' (remote)' : ''}</div>
        ${d.isPlaying ? '<div style="font-size:11px;color:#ffa502;margin-top:4px;">Playing: ' + (d.currentFile || '') + '</div>' : ''}
        ${d.authenticated === false ? '<div style="font-size:11px;color:#ff6b6b;margin-top:4px;">Not authenticated</div>' : ''}
      </div>
    `).join("");
  }

  // ==================================================
  //  場景渲染
  // ==================================================

  function renderScenes(scenes) {
    // 分類：VTS 場景、播放場景、系統場景
    const groups = {
      "Playback": scenes.filter((s) => s.name.startsWith("play_day")),
      "VTube Studio": scenes.filter((s) => s.name.startsWith("vts_")),
      "Interactive": scenes.filter((s) => s.trigger),
      "System": scenes.filter((s) => !s.name.startsWith("play_day") && !s.name.startsWith("vts_") && !s.trigger),
    };

    let html = "";
    for (const [groupName, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      html += `<div class="scene-group-title">${groupName}</div>`;
      html += '<div class="scenes-grid">';
      for (const scene of items) {
        html += `
          <div class="scene-btn" onclick="triggerScene('${scene.name}')">
            <div class="name">${scene.description || scene.name}</div>
            <div class="meta">${scene.actionCount} actions${scene.trigger ? ' / auto' : ''}</div>
          </div>
        `;
      }
      html += "</div>";
    }
    sceneContainer.innerHTML = html;
  }

  // ==================================================
  //  事件日誌
  // ==================================================

  function renderLogBatch(events) {
    logEntries.innerHTML = "";
    for (const ev of events) {
      appendLog(ev, false);
    }
  }

  function appendLog(entry, prepend = true) {
    const div = document.createElement("div");
    div.className = "log-entry";
    const time = new Date(entry.timestamp).toLocaleTimeString();
    div.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-event">${entry.event}</span>
      <span class="log-data">${JSON.stringify(entry.data).substring(0, 80)}</span>
    `;
    if (prepend) {
      logEntries.prepend(div);
      while (logEntries.children.length > MAX_LOG_ENTRIES) {
        logEntries.removeChild(logEntries.lastChild);
      }
    } else {
      logEntries.appendChild(div);
    }
  }

  // ==================================================
  //  全域操控函式（供 HTML onclick 呼叫）
  // ==================================================

  window.triggerScene = function (sceneName) {
    if (ws?.readyState !== 1) return showToast("WebSocket not connected");
    ws.send(JSON.stringify({ type: "triggerScene", payload: { sceneName } }));
    showToast(`Scene: ${sceneName}`);
  };

  window.vtsExpression = function (file) {
    executeDevice("vtubestudio", "setExpression", { file, active: true, fadeTime: 0.3 });
  };

  window.vtsHotkey = function (name) {
    executeDevice("vtubestudio", "triggerHotkey", { name });
  };

  window.vtsRemoveAllExpressions = function () {
    executeDevice("vtubestudio", "removeAllExpressions", { fadeTime: 0.25 });
  };

  window.vtsMoveModel = function () {
    const positionX = parseFloat(document.getElementById("vtsPosX").value) || 0;
    const positionY = parseFloat(document.getElementById("vtsPosY").value) || 0;
    const rotation = parseFloat(document.getElementById("vtsRot").value) || 0;
    const size = parseFloat(document.getElementById("vtsSize").value) || 0;
    executeDevice("vtubestudio", "moveModel", {
      timeInSeconds: 0.5,
      positionX, positionY, rotation, size,
    });
  };

  window.vtsTint = function () {
    const hex = document.getElementById("vtsTintColor").value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    executeDevice("vtubestudio", "tintArtMesh", {
      colorTint: { colorR: r, colorG: g, colorB: b, colorA: 255 },
      artMeshMatcher: { tintAll: true },
    });
  };

  window.vtsTintReset = function () {
    executeDevice("vtubestudio", "tintArtMesh", {
      colorTint: { colorR: 255, colorG: 255, colorB: 255, colorA: 255 },
      artMeshMatcher: { tintAll: true },
    });
  };

  // ---- 日立 modal ----
  const hitachiOverlay = document.getElementById("hitachiOverlay");

  window.showHitachi = function () {
    hitachiOverlay.classList.add("show");
  };

  window.closeHitachi = function (e) {
    if (e.target === hitachiOverlay || e.target.classList.contains("hitachi-close")) {
      hitachiOverlay.classList.remove("show");
    }
  };

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && hitachiOverlay.classList.contains("show")) {
      hitachiOverlay.classList.remove("show");
    }
  });

  // ---- Wiz Light 狀態更新 ----

  function updateWizStatus(data) {
    const bar = document.getElementById("wizStatusBar");
    if (!bar) return;
    bar.textContent = `Status: ${data?.status || "--"}${data?.error ? " | " + data.error : ""}`;
  }

  // ---- Wiz Light 控制 ----

  window.wizPower = function (state) {
    executeDevice("wizlight", state, {});
  };

  window.wizBrightness = function (val) {
    executeDevice("wizlight", "setBrightness", { brightness: Number(val) });
  };

  window.wizColor = function () {
    const hex = document.getElementById("wizColorPicker").value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const brightness = Number(document.getElementById("wizBrightness").value);
    executeDevice("wizlight", "setColor", { r, g, b, brightness });
  };

  window.wizTemp = function (temp) {
    const brightness = Number(document.getElementById("wizBrightness").value);
    executeDevice("wizlight", "setTemp", { temp, brightness });
  };

  window.wizScene = function (sceneId) {
    executeDevice("wizlight", "setScene", { sceneId });
  };

  function executeDevice(deviceId, action, params) {
    if (ws?.readyState !== 1) return showToast("WebSocket not connected");
    ws.send(JSON.stringify({
      type: "executeDevice",
      payload: { deviceId, action, params },
    }));
    showToast(`${deviceId} → ${action}`);
  }

  // ==================================================
  //  Toast 通知
  // ==================================================

  let toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
  }

  // 啟動連線
  connect();

  // 每 10 秒刷新一次裝置狀態
  setInterval(requestStatus, 10000);
})();
