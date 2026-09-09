// lib/chat-sound.ts — 全局消息提示音与触感反馈服务
"use client";

import { loadChatAppSettings } from "./chat-storage";

let _audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!_audioContext) {
    try {
      _audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return _audioContext;
}

/**
 * 播放清脆的新消息提示音（双音调气泡微水滴音效：880Hz -> 1760Hz）
 * 使用纯 Web Audio 合成，无需加载外部 mp3 资源，零网络延迟且保证跨端一致性
 */
export function playMessageSound(): void {
  if (typeof window === "undefined") return;
  const settings = loadChatAppSettings();
  if (settings.messageSoundEnabled === false) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // 主音频振荡器：优雅的马林巴/水滴叮咚音
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(880, now); // A5
    osc1.frequency.exponentialRampToValueAtTime(1320, now + 0.08); // E6

    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.exponentialRampToValueAtTime(0.28, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.25);

    // 泛音副振荡器（增强清透感）
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1760, now + 0.04); // A6
    osc2.frequency.exponentialRampToValueAtTime(2640, now + 0.12);

    gain2.gain.setValueAtTime(0.001, now + 0.04);
    gain2.gain.exponentialRampToValueAtTime(0.18, now + 0.06);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    osc2.start(now + 0.04);
    osc2.stop(now + 0.32);

    // 配合轻微振动反馈（支持振动的设备）
    if (navigator.vibrate) {
      navigator.vibrate(25);
    }
  } catch (e) {
    console.warn("[ChatSound] 播放提示音失败:", e);
  }
}
