"""
音訊模組 — USB mic + VAD + Deepgram STT

事件：
  publish('speech', { text: str, confidence: float })

收命令：
  startListening — 啟用 mic + STT（active 模式）
  stopListening  — 停用 mic（passive / idle 模式）

模式：
  AGENT_REAL=1 + DEEPGRAM_API_KEY → 真實模式（sounddevice + webrtcvad + Deepgram）← TODO 硬體到位後實作
  其他                              → mock 模式（startListening 後 2s 發「你好」假 speech）
"""

import asyncio
import os


class AudioModule:
    def __init__(self, server) -> None:
        self.server = server
        self.use_real = os.environ.get("AGENT_REAL", "0") == "1"
        self.deepgram_key = os.environ.get("DEEPGRAM_API_KEY")
        self.listening = False
        self._mock_task: asyncio.Task | None = None

    async def start(self) -> None:
        if self.use_real and self.deepgram_key:
            print("[audio] real mode — USB mic + Deepgram (TODO)")
        else:
            reason = "AGENT_REAL=0" if not self.use_real else "DEEPGRAM_API_KEY 未設"
            print(f"[audio] mock mode（{reason}）— startListening 後 2s 發「你好」假 speech")
        # idle loop 撐住模組（事件驅動由 on_command 觸發）
        while True:
            await asyncio.sleep(3600)

    async def on_command(self, command: str, params: dict) -> None:
        if command == "startListening":
            if self.listening:
                return
            self.listening = True
            print("[audio] startListening")
            if self.use_real and self.deepgram_key:
                # 真實模式啟動 mic 串流
                await self._start_real_stt()
            else:
                # mock：延遲 2s 發一句假 speech 觸發 LLM 對話迴圈
                self._mock_task = asyncio.create_task(self._mock_speech())
        elif command == "stopListening":
            if not self.listening:
                return
            self.listening = False
            print("[audio] stopListening")
            if self._mock_task and not self._mock_task.done():
                self._mock_task.cancel()
            if self.use_real and self.deepgram_key:
                await self._stop_real_stt()

    # =========================================
    #  Mock：固定打招呼，讓 Node 端走完 _onSpeech → Claude tool use 整條路徑
    # =========================================
    async def _mock_speech(self) -> None:
        try:
            await asyncio.sleep(2)
            if not self.listening:
                return
            await self.server.publish("speech", {
                "text": "你好",
                "confidence": 0.95,
                "mock": True,
            })
        except asyncio.CancelledError:
            return

    # =========================================
    #  Real：sounddevice + webrtcvad + Deepgram — TODO 硬體到位後實作
    # =========================================
    async def _start_real_stt(self) -> None:
        # 預期實作：
        #   import sounddevice as sd
        #   import webrtcvad
        #   from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions
        #
        #   1. sd.InputStream 啟動 16kHz mono
        #   2. webrtcvad 切音段：用戶講完話（靜音 >800ms）才送 STT
        #   3. Deepgram WebSocket live transcription，model="nova-2", language="zh-TW"
        #   4. transcription final → publish('speech', { text, confidence })
        raise NotImplementedError("real audio STT 尚未實作 — 需要 sounddevice + webrtcvad + Deepgram SDK")

    async def _stop_real_stt(self) -> None:
        raise NotImplementedError
