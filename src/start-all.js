const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Node.js 展覽主控（靜音，只顯示 YOLO 輸出）
const node = spawn("node", ["src/app.js", ...process.argv.slice(2)], {
  cwd: root,
  stdio: ["inherit", "ignore", "ignore"],
});

// Python YOLO 視覺辨識伺服器
const python = spawn("py", ["yolo/src/server.py"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    YOLO_PROFILE: "y11",
    CHOPSTICKS_MODEL_Y11: "yolo/models/chopsticks.pt",
    FOOD_MODEL_Y11: "yolo/models/food.pt",
    BOWL_MODEL_Y11: "",
    // 裁切攝影機畫面，只保留桌面區域 (歸一化座標 x1,y1,x2,y2)
    CAMERA_CROP: "0.05,0.0,0.65,1.0",
    DETECT_EVERY_N: "5",
    CHOPSTICKS_CONF: "0.08",
    CHOPSTICKS_MIN_ASPECT: "2.0",
    FOOD_MODEL_Y11: "yolo/models/food.pt",
    FOOD_CONF: "0.50",
    FOOD_MAX_DET: "6",
    // 固定碗區域 (裁切後畫面的歸一化座標)
    LEFT_BOWL_ZONE: "0.05,0.05,0.40,0.40",
    RIGHT_BOWL_ZONE: "0.40,0.05,0.75,0.40",
  },
});

node.on("error", (err) => console.error("[Node] 啟動失敗:", err.message));
python.on("error", (err) => console.error("[YOLO] 啟動失敗:", err.message));

// 任一程序結束時，關閉另一個
node.on("exit", (code) => {
  console.log(`[Node] 已結束 (code=${code})`);
  python.kill();
});

python.on("exit", (code) => {
  console.log(`[YOLO] 已結束 (code=${code})`);
  node.kill();
});

// Ctrl+C 時一起關閉
process.on("SIGINT", () => {
  node.kill();
  python.kill();
});
