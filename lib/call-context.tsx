// lib/call-context.tsx — 全局语音/视频通话状态与悬浮胶囊管理
"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { ChatSession } from "@/lib/chat-storage";
import type { Character } from "@/lib/character-types";

export type ActiveCall = {
    session: ChatSession;
    character: Character;
    type: "voice" | "video";
    initiator?: "user" | "character";
    initiatorName?: string;
};

type CallContextValue = {
    activeCall: ActiveCall | null;
    isMinimized: boolean;
    startCall: (call: ActiveCall) => void;
    endCall: () => void;
    minimizeCall: () => void;
    maximizeCall: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
    const [isMinimized, setIsMinimized] = useState(false);

    const startCall = useCallback((call: ActiveCall) => {
        setActiveCall(call);
        setIsMinimized(false);
    }, []);

    const endCall = useCallback(() => {
        setActiveCall(null);
        setIsMinimized(false);
    }, []);

    const minimizeCall = useCallback(() => {
        setIsMinimized(true);
    }, []);

    const maximizeCall = useCallback(() => {
        setIsMinimized(false);
    }, []);

    return (
        <CallContext.Provider value={{ activeCall, isMinimized, startCall, endCall, minimizeCall, maximizeCall }}>
            {children}
        </CallContext.Provider>
    );
}

export function useGlobalCall(): CallContextValue {
    const ctx = useContext(CallContext);
    if (!ctx) {
        return {
            activeCall: null,
            isMinimized: false,
            startCall: () => {},
            endCall: () => {},
            minimizeCall: () => {},
            maximizeCall: () => {},
        };
    }
    return ctx;
}
