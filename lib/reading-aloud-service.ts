// lib/reading-aloud-service.ts — 全局阅读朗读调度器与悬浮窗控制桥
"use client";

import { resolveVoiceConfig, synthesizeSpeech, playAudioBlobViaMediaElement } from "./tts-service";
import type { BookChapter } from "./reading-types";

export type ReadingAloudState = {
  active: boolean;
  paused: boolean;
  bookId: string;
  bookTitle: string;
  companionId: string;
  companionName: string;
  companionAvatar?: string;
  chapterIndex: number;
  paragraphIndex: number;
  totalParagraphs: number;
  statusText: string;
};

type StateListener = (state: ReadingAloudState) => void;

let _state: ReadingAloudState = {
  active: false,
  paused: false,
  bookId: "",
  bookTitle: "",
  companionId: "",
  companionName: "",
  companionAvatar: "",
  chapterIndex: 0,
  paragraphIndex: 0,
  totalParagraphs: 0,
  statusText: "",
};

const _listeners = new Set<StateListener>();
let _currentAbort: (() => void) | null = null;
let _runToken = 0;

function notify() {
  const copy = { ..._state };
  _listeners.forEach((fn) => {
    try {
      fn(copy);
    } catch {}
  });
}

export function getReadingAloudState(): ReadingAloudState {
  return { ..._state };
}

export function subscribeReadingAloudState(listener: StateListener): () => void {
  _listeners.add(listener);
  listener({ ..._state });
  return () => {
    _listeners.delete(listener);
  };
}

export function stopReadingAloud(): void {
  _runToken += 1;
  if (_currentAbort) {
    _currentAbort();
    _currentAbort = null;
  }
  _state = {
    ..._state,
    active: false,
    paused: false,
    statusText: "",
  };
  notify();
}

export function pauseReadingAloud(): void {
  if (!_state.active || _state.paused) return;
  _state = { ..._state, paused: true, statusText: "已暂停朗读" };
  if (_currentAbort) {
    _currentAbort();
    _currentAbort = null;
  }
  notify();
}

function parseParagraphSegments(text: string) {
  const segments: { text: string; isDialogue: boolean; emotion?: string }[] = [];
  const regex = /(“[^”]+”|"[^"]+"|「[^」]+」)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const preContext = text.substring(Math.max(0, match.index - 30), match.index);
    const postContext = text.substring(regex.lastIndex, Math.min(text.length, regex.lastIndex + 30));
    const context = `${preContext} ${postContext}`;

    if (match.index > lastIdx) {
      const narration = text.substring(lastIdx, match.index).trim();
      if (narration) segments.push({ text: narration, isDialogue: false, emotion: "neutral" });
    }
    const dialogue = match[1].replace(/^[“"「]|[”"」]$/g, "").trim();
    if (dialogue) {
      let emotion = "fluent";
      if (/(怒|吼|咆哮|厉声|骂|瞪|咬牙|攥紧拳|拍桌|冷哼)/.test(context) || /[！!]/.test(dialogue) || /(混蛋|可恶|找死|闭嘴|滚)/.test(dialogue)) {
        emotion = "angry";
      } else if (/(哭|泪|哽咽|抽泣|叹息|绝望|哀求|凄凉)/.test(context) || /(救救|难过|对不起|为什么会这样)/.test(dialogue)) {
        emotion = "sad";
      } else if (/(惊|愕|愣|骇然|瞪大眼|倒吸|倒抽|难以置信)/.test(context) || /[？\?]/.test(dialogue) || /(怎么会|难道|怎么可能|什么)/.test(dialogue)) {
        emotion = "surprised";
      } else if (/(颤|抖|害怕|惶恐|瑟瑟|退后|畏惧)/.test(context) || /(别过来|怕)/.test(dialogue)) {
        emotion = "fearful";
      } else if (/(笑|乐|欣喜|调侃|打趣|勾起唇|挑眉)/.test(context) || /(太好了|哈哈|嘿嘿|真棒|好呀)/.test(dialogue)) {
        emotion = "happy";
      }
      segments.push({ text: dialogue, isDialogue: true, emotion });
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    const rest = text.substring(lastIdx).trim();
    if (rest) segments.push({ text: rest, isDialogue: false, emotion: "neutral" });
  }

  return segments;
}

export async function startReadingAloudWorkflow({
  bookId,
  bookTitle,
  companionId,
  companionName,
  companionAvatar,
  chapters,
  chapterIndex,
  startParagraphIndex = 0,
}: {
  bookId: string;
  bookTitle: string;
  companionId: string;
  companionName: string;
  companionAvatar?: string;
  chapters: BookChapter[];
  chapterIndex: number;
  startParagraphIndex?: number;
}): Promise<void> {
  const voiceConfig = resolveVoiceConfig(companionId);
  if (!voiceConfig) {
    throw new Error("当前陪读角色尚未在「设置 → 语音设置」中绑定音色！");
  }

  stopReadingAloud();
  const myToken = ++_runToken;

  const currentCh = chapters[chapterIndex];
  if (!currentCh || !currentCh.paragraphs || currentCh.paragraphs.length === 0) {
    return;
  }

  const paras = currentCh.paragraphs;
  _state = {
    active: true,
    paused: false,
    bookId,
    bookTitle,
    companionId,
    companionName,
    companionAvatar: companionAvatar || "",
    chapterIndex,
    paragraphIndex: startParagraphIndex,
    totalParagraphs: paras.length,
    statusText: `正在朗读 第${chapterIndex + 1}章 · 第${startParagraphIndex + 1}/${paras.length}段`,
  };
  notify();

  try {
    let nextAudioPromise: Promise<Blob | null> | null = null;

    for (let pIdx = Math.max(0, startParagraphIndex); pIdx < paras.length; pIdx++) {
      if (_runToken !== myToken || !_state.active || _state.paused) break;
      const pText = paras[pIdx].trim();
      if (!pText) continue;

      _state.paragraphIndex = pIdx;
      _state.statusText = `正在朗读 第${chapterIndex + 1}章 · 第${pIdx + 1}/${paras.length}段`;
      notify();

      const segments = parseParagraphSegments(pText);
      for (let sIdx = 0; sIdx < segments.length; sIdx++) {
        if (_runToken !== myToken || !_state.active || _state.paused) break;
        const seg = segments[sIdx];
        if (!seg.text.trim()) continue;

        let currentBlob: Blob | null = null;
        if (nextAudioPromise) {
          currentBlob = await nextAudioPromise;
          nextAudioPromise = null;
        } else {
          currentBlob = await synthesizeSpeech(seg.text, voiceConfig, {
            emotion: seg.isDialogue ? seg.emotion : "neutral",
          });
        }

        if (_runToken !== myToken || !_state.active || _state.paused) break;

        // 流水线双缓冲预拉取下一片段（消除停顿）
        let nextSeg: typeof seg | undefined;
        if (sIdx + 1 < segments.length) {
          nextSeg = segments[sIdx + 1];
        } else if (pIdx + 1 < paras.length) {
          const nextPText = paras[pIdx + 1].trim();
          if (nextPText) {
            const nextParasSegs = parseParagraphSegments(nextPText);
            if (nextParasSegs.length > 0) nextSeg = nextParasSegs[0];
          }
        }

        if (nextSeg && nextSeg.text.trim()) {
          nextAudioPromise = synthesizeSpeech(nextSeg.text, voiceConfig, {
            emotion: nextSeg.isDialogue ? nextSeg.emotion : "neutral",
          }).catch(() => null);
        }

        if (currentBlob) {
          const { promise, abort } = playAudioBlobViaMediaElement(currentBlob);
          _currentAbort = abort;
          await promise;
          _currentAbort = null;
        }
      }
    }
  } catch (err) {
    console.warn("[ReadingAloud] 朗读流程中断或异常:", err);
  } finally {
    if (_runToken === myToken && _state.active && !_state.paused) {
      stopReadingAloud();
    }
  }
}
