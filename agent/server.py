"""
AI Agent Python 服務 — 主入口
與 Node.js 端 (src/devices/AIAgentDevice.js) 透過 WebSocket 互通

訊息格式：
  Python → Node:  { "type": "speech" | "gesture" | "gaze", "data": {...} }
  Node → Python:  { "command": "startListening" | "stopListening" | ..., "params": {...} }

模式切換：
  AGENT_REAL=1 + 硬體就位 → 真實模式（C230 RTSP + USB mic + Deepgram STT）
  預設            → mock 模式（每 5s 假 gaze、收到 startListening 後模擬「你好」）
"""

import asyncio
import json
import os
import signal
import sys
from typing import Set

import websockets


HOST = os.environ.get("AGENT_HOST", "localhost")
PORT = int(os.environ.get("AGENT_PORT", "9000"))


class AgentServer:
    """中央 hub — 模組透過 publish() 廣播事件給所有 Node.js 客戶端，
    並透過 register_module() 收 Node.js 來的 commands"""

    def __init__(self) -> None:
        self.clients: Set[websockets.WebSocketServerProtocol] = set()
        self.modules: list = []

    def register_module(self, module) -> None:
        self.modules.append(module)

    async def publish(self, event_type: str, data: dict) -> None:
        msg = json.dumps({"type": event_type, "data": data}, ensure_ascii=False)
        if not self.clients:
            return
        # 同步廣播給所有客戶端，斷線者自動忽略
        await asyncio.gather(
            *(self._safe_send(ws, msg) for ws in list(self.clients)),
            return_exceptions=True,
        )

    @staticmethod
    async def _safe_send(ws, msg) -> None:
        try:
            await ws.send(msg)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def _dispatch_command(self, command: str, params: dict) -> None:
        for m in self.modules:
            handler = getattr(m, "on_command", None)
            if handler is None:
                continue
            try:
                await handler(command, params)
            except Exception as exc:
                print(f"[server] 模組 {type(m).__name__} 處理 {command} 失敗: {exc}", file=sys.stderr)

    async def handle_client(self, ws) -> None:
        # websockets 12.x 的 handler 只接 ws；path 透過 ws.request.path 取
        path = getattr(getattr(ws, "request", None), "path", "/")
        if path != "/agent":
            await ws.close(code=4404, reason="unknown path")
            return

        self.clients.add(ws)
        print(f"[server] Node.js 已連線 (clients={len(self.clients)})")
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError as exc:
                    print(f"[server] 無效 JSON: {exc}")
                    continue
                command = msg.get("command")
                params = msg.get("params", {}) or {}
                if command:
                    print(f"[server] command={command} params={params}")
                    await self._dispatch_command(command, params)
        finally:
            self.clients.discard(ws)
            print(f"[server] Node.js 斷線 (clients={len(self.clients)})")


async def main() -> None:
    server = AgentServer()

    # 動態 import 避免啟動時就要求所有 (重型) 依賴存在
    from vision import VisionModule
    from audio import AudioModule

    vision = VisionModule(server)
    audio = AudioModule(server)
    server.register_module(vision)
    server.register_module(audio)

    asyncio.create_task(vision.start())
    asyncio.create_task(audio.start())

    print(f"[server] 啟動於 ws://{HOST}:{PORT}/agent")
    print(f"[server] AGENT_REAL={os.environ.get('AGENT_REAL', '0')}")
    async with websockets.serve(server.handle_client, HOST, PORT):
        # 優雅關閉
        loop = asyncio.get_running_loop()
        stop = loop.create_future()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set_result, None)
            except NotImplementedError:
                # Windows 部分版本不支援 signal handler
                pass
        await stop
        print("[server] 收到關閉訊號，退出")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
