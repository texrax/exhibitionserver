const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Node.js 展覽主控
const node = spawn("node", ["src/app.js", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

node.on("error", (err) => console.error("[Node] 啟動失敗:", err.message));

node.on("exit", (code) => {
  console.log(`[Node] 已結束 (code=${code})`);
  process.exit(code || 0);
});

// Ctrl+C 時關閉
process.on("SIGINT", () => {
  node.kill();
});
