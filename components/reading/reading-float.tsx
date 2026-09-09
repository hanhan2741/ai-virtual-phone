// components/reading/reading-float.tsx — 离开阅读器时的全局悬浮控制胶囊
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Volume2, Pause, Play, X, BookOpen } from "lucide-react";
import {
  subscribeReadingAloudState,
  stopReadingAloud,
  pauseReadingAloud,
  startReadingAloudWorkflow,
  type ReadingAloudState,
} from "@/lib/reading-aloud-service";
import { loadChapters } from "@/lib/reading-storage";

export function ReadingFloat({ onOpenReading }: { onOpenReading?: (bookId: string) => void }) {
  const [state, setState] = useState<ReadingAloudState | null>(null);
  const [pos, setPos] = useState({ x: 16, y: 76 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, originX: 0, originY: 0 });

  useEffect(() => {
    return subscribeReadingAloudState((next) => {
      setState(next.active ? next : null);
    });
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 220, dragStartRef.current.originX + dx)),
      y: Math.max(48, Math.min(window.innerHeight - 80, dragStartRef.current.originY + dy)),
    });
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
  };

  const handleTogglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!state) return;
    if (!state.paused) {
      pauseReadingAloud();
    } else {
      const chapters = loadChapters(state.bookId);
      void startReadingAloudWorkflow({
        bookId: state.bookId,
        bookTitle: state.bookTitle,
        companionId: state.companionId,
        companionName: state.companionName,
        companionAvatar: state.companionAvatar,
        chapters,
        chapterIndex: state.chapterIndex,
        startParagraphIndex: state.paragraphIndex,
      });
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopReadingAloud();
  };

  const handleNavigateBack = () => {
    if (state?.bookId && onOpenReading) {
      onOpenReading(state.bookId);
    }
  };

  if (!state || !state.active) return null;

  return (
    <div
      className="reading-global-float"
      style={{
        position: "fixed",
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px 6px 6px",
        background: "rgba(15, 23, 42, 0.88)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.15)",
        borderRadius: "24px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        color: "#f8fafc",
        userSelect: "none",
        cursor: "grab",
        touchAction: "none",
        maxWidth: "280px",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleNavigateBack}
    >
      <div
        style={{
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          overflow: "hidden",
          background: "rgba(255,255,255,0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {state.companionAvatar ? (
          <img src={state.companionAvatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <BookOpen size={14} color="#38bdf8" />
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "#38bdf8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {state.companionName ? `${state.companionName} 朗读中` : "朗读中"}
        </div>
        <div style={{ fontSize: "10px", color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {state.statusText || state.bookTitle || "点击返回阅读"}
        </div>
      </div>

      <button
        type="button"
        onClick={handleTogglePlay}
        style={{
          background: "rgba(255, 255, 255, 0.12)",
          border: "none",
          borderRadius: "50%",
          width: "26px",
          height: "26px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          cursor: "pointer",
          flexShrink: 0,
        }}
        title={state.paused ? "继续朗读" : "暂停朗读"}
      >
        {state.paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
      </button>

      <button
        type="button"
        onClick={handleClose}
        style={{
          background: "transparent",
          border: "none",
          color: "rgba(255, 255, 255, 0.6)",
          width: "20px",
          height: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
        }}
        title="停止并关闭"
      >
        <X size={14} />
      </button>
    </div>
  );
}
