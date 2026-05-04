// 一條命令啟動：Python agent + Node 主控
// venv 不存在時 Node 仍會跑（agent 連不上時 graceful fallback）

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// ---- Python agent（如 agent/venv 已建立則自動跑） ----
const venvPython = process.platform === "win32"
  ? path.join(root, "agent", "venv", "Scripts", "python.exe")
  : path.join(root, "agent", "venv", "bin", "python");
const agentScript = path.join(root, "agent", "server.py");

let pyAgent = null;
if (fs.existsSync(venvPython) && fs.existsSync(agentScript)) {
  console.log("[start-all] 啟動 Python agent...");
  pyAgent = spawn(venvPython, [agentScript], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  pyAgent.on("error", (err) => console.error("[Python agent] 啟動失敗:", err.message));
  pyAgent.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`[Python agent] 已結束 (code=${code})`);
    pyAgent = null;
  });
} else {
  console.log(
    "[start-all] 略過 Python agent — 未找到 agent/venv。" +
    "首次安裝：cd agent && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
  );
}

// ---- Node 主控 ----
const node = spawn("node", ["src/app.js", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

node.on("error", (err) => console.error("[Node] 啟動失敗:", err.message));
node.on("exit", (code) => {
  if (pyAgent) pyAgent.kill();
  process.exit(code || 0);
});

const shutdown = () => {
  if (pyAgent) pyAgent.kill();
  node.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
