"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult, ChatEngineError } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { BilingualTextBlock } from "./message-bubble";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { startIncomingCallVibration } from "@/lib/call-vibration";

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

type VoiceCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
};

function stripBilingualForSpeech(text: string): string {
    return text
        .split("\n")
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n");
}

// ── Component ───────────────────────────────────────

export function VoiceCallScreen({ session, character, onEnd, onConnect, initiator = "user" }: VoiceCallScreenProps) {
    // iOS 保留 Web Speech 免提 + Web Audio 播放（麦克风会话共存的老方案）；
    // 其余设备改「按住说话 + 云端转写」，播放走媒体元素（音量键可控、无静音拨键坑）。
    // 没配 OpenAI 兼容识别时回落旧行为（安卓=文字输入）。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig(session.contactId) !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !holdToTalkRef.current);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);

    // 哄睡弹窗与配置状态
    const [showLullabyModal, setShowLullabyModal] = useState(false);
    const [lullabyPlot, setLullabyPlot] = useState("");
    const [lullabyLength, setLullabyLength] = useState("5000");
    const [lullabyCustomPrompt, setLullabyCustomPrompt] = useState("");
    const [lullabyAutoHangupMinutes, setLullabyAutoHangupMinutes] = useState("30");
    const autoHangupTimerRef = useRef<NodeJS.Timeout | null>(null);

    // 悬浮小窗 / 画中画模式状态
    const [isMinimized, setIsMinimized] = useState(false);
    const [miniPos, setMiniPos] = useState({ x: 20, y: 80 });
    const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number; isDragging: boolean }>({
        startX: 0, startY: 0, posX: 20, posY: 80, isDragging: false
    });

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const stateRef = useRef<string>("CONNECTING");
    const interimTextRef = useRef<string>("");  // ref 版本，闭包安全
    const sttWarningShownRef = useRef(false);
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");

    // Keep refs in sync
    useEffect(() => { stateRef.current = callState; }, [callState]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);

    // 1. 屏幕常亮保活（Screen WakeLock）：防止通话/哄睡长篇播放时手机自动变暗熄屏
    useEffect(() => {
        let wakeLock: any = null;
        const requestWakeLock = async () => {
            try {
                if ("wakeLock" in navigator && (navigator as any).wakeLock) {
                    wakeLock = await (navigator as any).wakeLock.request("screen");
                }
            } catch (err) {
                console.log("[VoiceCall] WakeLock error:", err);
            }
        };
        void requestWakeLock();

        const handleVisibility = () => {
            if (document.visibilityState === "visible" && stateRef.current !== "ENDED") {
                void requestWakeLock();
            }
        };
        document.addEventListener("visibilitychange", handleVisibility);

        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            if (wakeLock) {
                wakeLock.release().catch(() => {});
                wakeLock = null;
            }
        };
    }, []);

    // 2. 通话期间周期性取消后台追问/冷场预约，防止通话中途服务端/本地后台误发消息
    useEffect(() => {
        cancelFollowUp(session.id);
        const suppressTimer = setInterval(() => {
            if (stateRef.current !== "ENDED") {
                cancelFollowUp(session.id);
            }
        }, 10_000);
        return () => clearInterval(suppressTimer);
    }, [session.id]);

    // 通话音频会话 + 卸载兜底：不经挂断键退出（返回聊天页/切会话/组件被销毁）时，
    // 把识别、在途播放与音频会话全部释放。此前识别的自动重启循环在卸载后条件
    // 恒成立（stateRef 停在 IDLE），会在后台无限自我重启，麦克风永不归还，
    // 整页音频被钉在通话模式（语音条/试听音量巨大且音量键失灵）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            cancelFollowUp(session.id);
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            setCallAudioSessionActive(false);
        };
    }, [session.id]);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    // Scroll subtitles to bottom on change
    useEffect(() => {
        if (subtitleScrollRef.current) {
            subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight;
        }
    }, [subtitles, interimText]);

    // ── Resolve voiceBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.voiceBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setBgImageResolved(session.voiceBackground);
            return;
        }
        // IndexedDB ID
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.voiceBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;

        if (!callStartRef.current) {
            callStartRef.current = Date.now();
        }

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [callState]);

    // ── Connecting animation (3s fake dial) ─────────

    useEffect(() => {
        cancelFollowUp(session.id);

        // Resolve user name
        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";

        // Load existing messages for context
        messagesRef.current = loadChatMessages(session.id);

        // Insert system message (skip if already exists from strict mode remount)
        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了语音通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了语音通话]`
                : `[我向${character.name}发起了语音通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => {
                setCallState("IDLE");
            }, 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    // ── Format time MM:SS ───────────────────────────

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    // ── State label ─────────────────────────────────

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing (same logic as chat-room) ──

    const processAIResponse = useCallback((aiResponseText: string): { cleanParts: string[]; stateValues: StateValue[] } => {
        // Use shared parseAIResponse for full rich media support (stickers, quotes, etc.)
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types (voice_call, video_call, poke, etc.)
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        // Save messages to storage
        if (chatParts.length === 0 && (statusPanel || innerMonologue)) {
            const aiMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            });
            messagesRef.current = [...messagesRef.current, aiMsg];
        } else {
            const newMsgs = chatParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    statusRegionMode: idx === 0 && statusPanel ? statusRegionMode : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            );
            messagesRef.current = [...messagesRef.current, ...newMsgs];
        }

        // Return clean text parts for TTS (exclude rich media content)
        const cleanParts = chatParts
            .filter(p => !p.mediaType && p.content.trim())
            .map(p => p.content);

        return { cleanParts, stateValues };
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const runConversationTurn = useCallback(async (userText?: string) => {
        // 1. Save user message (skip for initial greeting)
        if (userText) {
            const userMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: userText,
            });
            messagesRef.current = [...messagesRef.current, userMsg];

            // Add user subtitle
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText }]);
        }

        // 2. Switch to PROCESSING
        setCallState("PROCESSING");
        setInterimText("");

        try {
            // 3. Generate AI response
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, messagesRef.current, {
                appTags: ["chat", "voice"],
            }));

            // Bail if call ended during generation
            if (stateRef.current === "ENDED") return;

            // 4. Process response
            const { cleanParts } = processAIResponse(aiResponseText);
            const displayText = cleanParts.join("\n");
            const speechText = stripBilingualForSpeech(displayText);

            if (!displayText) {
                setCallState("IDLE");
                return;
            }

            // 5. Add AI subtitle
            const subtitleId = `ai-${Date.now()}`;
            setSubtitles(prev => [...prev, { id: subtitleId, role: "assistant", text: displayText }]);

            // 6. TTS
            setCallState("AI_SPEAKING");

            const voiceConfig = resolveVoiceConfig(session.contactId);
            if (voiceConfig) {
                try {
                    const audioBlob = await synthesizeSpeech(speechText, voiceConfig);
                    if (stateRef.current === "ENDED") return;

                    if (audioBlob) {
                        // 注册锁屏系统媒体控制（MediaSession），让熄屏/锁屏后音频通道依然保持播放
                        if ("mediaSession" in navigator && typeof window !== "undefined") {
                            navigator.mediaSession.metadata = new MediaMetadata({
                                title: `与 ${character.name} 语音通话中`,
                                artist: character.name,
                                album: "AI 虚拟小手机",
                                artwork: character.avatar ? [{ src: character.avatar, sizes: "512x512", type: "image/png" }] : [],
                            });
                        }
                        const { promise, abort } = playCallAudio(audioBlob);
                        audioAbortRef.current = abort;
                        await promise;
                        audioAbortRef.current = null;
                    }
                } catch (e) {
                    console.warn("[VoiceCall] TTS failed:", e);
                }
            }

            if (stateRef.current !== "ENDED") {
                setCallState("IDLE");
            }
        } catch (error: any) {
            console.error("[VoiceCall] Error:", error);
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    text: `⚠️ ${error?.message || "发送失败"}`,
                }]);
                setCallState("IDLE");
            }
        }
    }, [session, processAIResponse, playCallAudio]);

    // ── Auto-listen: 进入 IDLE 自动开始监听 ────────

    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setInterimText("");
        interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                interimTextRef.current = text;
                // 有中间结果 → 切到 USER_SPEAKING
                if (stateRef.current === "IDLE") {
                    setCallState("USER_SPEAKING");
                }
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) {
                    runConversationTurn(text.trim());
                } else {
                    setInterimText("");
                    setCallState("IDLE");
                }
            },
            onError: (error) => {
                console.warn("[VoiceCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                showSttCompatibilityWarning();
                // 严重错误，回到 IDLE（会触发重新监听）
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    setCallState("IDLE");
                }
            },
            onNoSpeech: () => {
                // 没检测到语音 → 静默重新开始监听
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    // 短暂延迟后重启，避免快速循环
                    setTimeout(() => {
                        if (stateRef.current === "IDLE") {
                            startListening();
                        }
                    }, 300);
                }
            },
            onEnd: () => {
                // 没有 finalText 也没有 no-speech → 用 interimRef 兜底
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) {
                        runConversationTurn(fallback.trim());
                    } else {
                        setInterimText("");
                        setCallState("IDLE");
                    }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;

        if (stt.isSupported) {
            stt.start();
        } else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, holdToTalk, runConversationTurn, session.contactId, showSttCompatibilityWarning]);

    // IDLE 时自动开启监听（按住说话模式无自动监听，识别只在按住期间发生）
    useEffect(() => {
        if (holdToTalk) return;
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted) {
            // 短暂延迟让 UI 过渡完成
            const timer = setTimeout(() => {
                if (stateRef.current === "IDLE") {
                    startListening();
                }
            }, 500);
            return () => clearTimeout(timer);
        }
        // 静音时停止监听
        if (isMuted && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        runConversationTurn(text);
    }, [typedText, callState, runConversationTurn]);

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮
    const holdInput = useHoldToTalk({
        characterId: session.contactId,
        canStart: () => stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {
            if (stateRef.current === "USER_SPEAKING") setCallState("PROCESSING");
        },
        onTranscript: (text) => { void runConversationTurn(text); },
        onError: () => {
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    // ── 哄睡专属请求 ─────────────────────────────────
    const handleStartLullaby = useCallback(async () => {
        setShowLullabyModal(false);
        const plot = lullabyPlot.trim() || "在静谧的夜晚陪伴用户，给用户讲一段舒缓、安详的长篇睡前故事";
        const wordCount = lullabyLength || "5000";
        const customPrompt = lullabyCustomPrompt.trim();

        // 设定定时自动挂断
        if (autoHangupTimerRef.current) {
            clearTimeout(autoHangupTimerRef.current);
            autoHangupTimerRef.current = null;
        }
        const autoMins = parseInt(lullabyAutoHangupMinutes, 10);
        if (Number.isFinite(autoMins) && autoMins > 0) {
            autoHangupTimerRef.current = setTimeout(() => {
                if (stateRef.current !== "ENDED") {
                    handleHangup();
                }
            }, autoMins * 60 * 1000);
        }

        // 构造用户发起的哄睡指令（严守人设，但剧情严格按照用户设定的内容推进）
        const promptInstruction = `[系统指令：用户请求你进行深度睡前哄睡。
【核心要求】：
1. 保持你原本的性格、人设特征和对用户的专属态度、称呼不变。
2. 哄睡剧情严格按照用户指定的内容来深度展开，不要简略跳过，充分展开场景细节与故事脉络：
“${plot}”
3. 输出字数请充分展开，目标字数约为 ${wordCount} 字左右（篇幅充实、细节丰富）。
4. 语气请放缓、轻柔、温暖、极具陪伴感与沉浸感，像在枕边轻声细语耳语一样说话，去掉一切大声叫喊或惊叹标点。
${customPrompt ? `5. 补充要求：${customPrompt}` : ""}]`;

        void runConversationTurn(promptInstruction);
    }, [lullabyPlot, lullabyLength, lullabyCustomPrompt, lullabyAutoHangupMinutes, runConversationTurn]);

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        if (autoHangupTimerRef.current) {
            clearTimeout(autoHangupTimerRef.current);
            autoHangupTimerRef.current = null;
        }
        setCallState("ENDED");

        // Stop any ongoing STT
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }

        // Stop any ongoing audio playback
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }

        // Stop browser TTS
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        const endMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `[我挂断了语音通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];

        // Delay then close
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd]);

    // ── 小窗拖拽处理 ──
    const handleMiniPointerDown = (e: React.PointerEvent) => {
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            posX: miniPos.x,
            posY: miniPos.y,
            isDragging: false,
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handleMiniPointerMove = (e: React.PointerEvent) => {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            dragRef.current.isDragging = true;
            setMiniPos({
                x: Math.max(10, Math.min(window.innerWidth - 120, dragRef.current.posX + dx)),
                y: Math.max(40, Math.min(window.innerHeight - 150, dragRef.current.posY + dy)),
            });
        }
    };

    const handleMiniPointerUp = (e: React.PointerEvent) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        if (!dragRef.current.isDragging) {
            setIsMinimized(false);
        }
    };

    // ── Render ──────────────────────────────────────

    if (isMinimized && callState !== "ENDED") {
        return (
            <div
                className="fixed z-[1000] cursor-pointer select-none"
                style={{
                    left: `${miniPos.x}px`,
                    top: `${miniPos.y}px`,
                    touchAction: "none",
                }}
                onPointerDown={handleMiniPointerDown}
                onPointerMove={handleMiniPointerMove}
                onPointerUp={handleMiniPointerUp}
            >
                <div className="relative flex items-center gap-2.5 px-3 py-2 rounded-2xl bg-black/85 backdrop-blur-md border border-white/20 shadow-2xl text-white">
                    <div className="relative w-9 h-9 rounded-full overflow-hidden shrink-0 border border-white/30 bg-neutral-800">
                        {character.avatar ? (
                            <img src={character.avatar} alt={character.name} className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-xs font-bold">{character.name?.[0]}</div>
                        )}
                        {callState === "AI_SPEAKING" && (
                            <div className="absolute inset-0 rounded-full border-2 border-emerald-400 animate-ping opacity-75" />
                        )}
                    </div>
                    <div className="flex flex-col pr-1 min-w-[65px]">
                        <span className="text-xs font-semibold leading-tight truncate max-w-[85px]">{character.name}</span>
                        <span className="text-[10px] text-emerald-400 font-mono leading-tight">{formatTime(callDuration)}</span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="fixed inset-0 z-[1000] w-full h-full min-h-[100dvh] flex flex-col text-white overflow-hidden call-bg-default call-keyboard-shift"
            style={bgImageResolved ? { ...keyboardOffsetStyle, background: `url(${bgImageResolved}) center/cover no-repeat` } : keyboardOffsetStyle}
        >
            {/* Dark overlay for readability */}
            <div
                className="call-overlay absolute inset-0 z-0"
                {...(bgImageResolved ? { "data-has-image": "" } : {})}
            />

            <CallVolumeControl />

            {/* Content wrapper — force white text so themes don't override call UI */}
            <div className="voicecall-controls gcall-body">
                {/* Top: Duration + Status + Minimize Button (放在右上角，不遮挡音量键) */}
                <div className="gcall-topbar relative">
                    {callState !== "CONNECTING" && callState !== "ENDED" && (
                        <button
                            type="button"
                            onClick={() => setIsMinimized(true)}
                            className="absolute right-4 top-2 text-white p-2.5 rounded-full transition-transform active:scale-95 shadow-lg flex items-center justify-center cursor-pointer"
                            style={{ background: "rgba(0, 0, 0, 0.45)", border: "1px solid rgba(255, 255, 255, 0.3)", backdropFilter: "blur(10px)", zIndex: 50 }}
                            title="缩小为悬浮小窗"
                            aria-label="缩小为悬浮小窗"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="4 14 10 14 10 20"></polyline>
                                <polyline points="20 10 14 10 14 4"></polyline>
                                <line x1="14" y1="10" x2="21" y2="3"></line>
                                <line x1="3" y1="21" x2="10" y2="14"></line>
                            </svg>
                        </button>
                    )}
                    <div className="gcall-topbar-title">
                        {character.name}
                    </div>
                    <div
                        className="gcall-topbar-sub"
                        {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                    >
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                </div>

                {/* Center: Avatar + connecting ring */}
                <div className="flex-none flex justify-center items-center pt-[30px] pb-5">
                    <div className="relative flex items-center justify-center">
                        <div
                            className="voicecall-avatar"
                            {...(callState === "AI_SPEAKING" ? { "data-speaking": "" } : {})}
                        >
                            {character.avatar ? (
                                <img
                                    src={character.avatar}
                                    alt={character.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <span className="ts-48 text-[var(--c-icon)]">
                                    {character.name?.[0] || "?"}
                                </span>
                            )}
                        </div>
                        {callState === "CONNECTING" && (
                            <>
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite",
                                    }}
                                />
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite 0.5s",
                                    }}
                                />
                            </>
                        )}
                    </div>
                </div>

                <div className="text-center ts-18 font-semibold mb-2">
                    {character.name}
                </div>

                {/* Subtitle area — top fade via mask */}
                <div
                    ref={subtitleScrollRef}
                    className="voicecall-subtitle-mask flex-1 min-h-0 overflow-auto px-5 py-[10px] flex flex-col gap-2 relative"
                    {...(inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" ? { "data-text-input": "" } : {})}
                >
                    {subtitles.map((sub) => (
                        <div
                            key={sub.id}
                            className="call-subtitle"
                            data-role={sub.role}
                        >
                            <BilingualTextBlock text={sub.text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                        </div>
                    ))}

                    {/* Interim STT text */}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="call-subtitle" data-interim="">
                            {interimText}
                        </div>
                    )}
                </div>

                {inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" && (
                    <form
                        className="call-text-input-panel voicecall-text-input-panel"
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleTextSubmit();
                        }}
                    >
                        <div className="call-text-input-shell">
                            <input
                                value={typedText}
                                onChange={e => setTypedText(e.target.value)}
                                className="call-text-input"
                                placeholder={callState === "IDLE" ? "输入你想说的话..." : "稍等对方说完..."}
                                disabled={callState !== "IDLE"}
                            />
                            <button
                                type="submit"
                                className="call-text-send-btn"
                                disabled={!typedText.trim() || callState !== "IDLE"}
                                aria-label="发送"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 19V5" />
                                    <path d="M5 12l7-7 7 7" />
                                </svg>
                            </button>
                        </div>
                    </form>
                )}

                {/* 按住说话提示/错误行 */}
                {holdToTalk && inputMode === "voice" && callState !== "CONNECTING" && callState !== "ENDED" && (
                    <div className="text-center ts-12 opacity-80 px-5">
                        {holdInput.recState === "recording" ? "松开发送"
                            : holdInput.recState === "transcribing" ? "识别中…"
                            : holdInput.error || "按住下方麦克风说话"}
                    </div>
                )}

                {/* Bottom controls */}
                <div
                    className="flex justify-center items-center gap-[24px] p-5"
                    style={{ paddingBottom: "max(30px, env(safe-area-inset-bottom))" }}
                >
                    {callState !== "ENDED" && callState !== "CONNECTING" && (
                        <button
                            onClick={() => setShowLullabyModal(true)}
                            className="ui-call-btn ui-call-btn-muted"
                            title="哄睡模式"
                            aria-label="哄睡模式"
                            style={{ background: "rgba(255, 255, 255, 0.18)", backdropFilter: "blur(8px)" }}
                        >
                            <span style={{ fontSize: "1.15rem" }}>🌙</span>
                        </button>
                    )}
                    {callState !== "ENDED" && callState !== "CONNECTING" ? holdToTalk ? (
                        <>
                            {/* 输入方式切换（按住说话模式不需要持续开麦，静音位改放 Aa 切换） */}
                            <button
                                onClick={handleInputModeToggle}
                                className="ui-call-btn ui-call-btn-muted"
                                aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            >
                                {inputMode === "voice" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* 按住说话主按钮（文字模式下点按切回语音） */}
                            <button
                                className="ui-call-mic ui-call-mic-lg"
                                style={{ touchAction: "none" }}
                                data-state={
                                    inputMode === "text" ? "text"
                                        : holdInput.recState === "recording" ? "speaking"
                                        : callState === "IDLE" ? "idle"
                                        : "busy"
                                }
                                aria-label={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                                title={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                                {...(inputMode === "voice" ? holdInput.pressHandlers : { onClick: handleInputModeToggle })}
                            >
                                {inputMode === "text" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Hangup */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                                aria-label="挂断"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                        </>
                    ) : androidTextInputOnly ? (
                        <button
                            onClick={handleHangup}
                            className="ui-call-btn ui-call-btn-danger"
                            aria-label="挂断"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    ) : (
                        <>
                            {/* Mute button */}
                            <button
                                onClick={() => setIsMuted(!isMuted)}
                                className="ui-call-btn ui-call-btn-muted"
                                {...(isMuted ? { "data-checked": "" } : {})}
                            >
                                {isMuted ? (
                                    /* Muted: mic with diagonal */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                        <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                                    </svg>
                                ) : (
                                    /* Active mic */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Mic button — input mode toggle with voice-state indicator */}
                            <button
                                onClick={handleInputModeToggle}
                                className="ui-call-mic ui-call-mic-lg"
                                data-state={
                                    inputMode === "text" ? "text"
                                        : callState === "USER_SPEAKING" ? "speaking"
                                        : callState === "IDLE" ? (isMuted ? "idle-muted" : "idle")
                                        : "busy"
                                }
                                aria-label={androidTextInputOnly ? "文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                                title={androidTextInputOnly ? "安卓浏览器使用文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            >
                                {inputMode === "text" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Hangup button */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                        </>
                    ) : callState === "CONNECTING" && initiator === "character" ? (
                        /* Incoming call: accept + decline */
                        <>
                            <button
                                onClick={() => {
                                    pushChatMessage({
                                        sessionId: session.id,
                                        role: "user",
                                        content: `[我拒绝了语音通话]`,
                                    });
                                    onEnd();
                                }}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                            <button
                                onClick={() => setCallState("IDLE")}
                                className="ui-call-btn ui-call-btn-success"
                            >
                                {/* Phone pick-up icon */}
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                </svg>
                            </button>
                        </>
                    ) : callState === "CONNECTING" ? (
                        /* User-initiated: show cancel only */
                        <button
                            onClick={() => {
                                pushChatMessage({
                                    sessionId: session.id,
                                    role: "user",
                                    content: `[我取消了语音通话]`,
                                });
                                onEnd();
                            }}
                            className="ui-call-btn ui-call-btn-danger"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    ) : (
                        /* ENDED state: show nothing, will auto-close */
                        <div className="ts-14 opacity-70">通话已结束</div>
                    )}
                </div>
            </div>

            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

            {/* 哄睡设置弹窗 */}
            {showLullabyModal && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center p-4"
                    style={{ background: "rgba(0, 0, 0, 0.65)", backdropFilter: "blur(6px)" }}
                    onClick={(e) => { if (e.target === e.currentTarget) setShowLullabyModal(false); }}
                >
                    <div
                        className="w-full max-w-[340px] rounded-2xl p-5 text-white flex flex-col gap-4 shadow-2xl"
                        style={{ background: "rgba(30, 32, 42, 0.95)", border: "1px solid rgba(255, 255, 255, 0.15)" }}
                    >
                        <div className="flex justify-between items-center pb-2 border-b border-white/10">
                            <div className="flex items-center gap-2 font-semibold text-base">
                                <span>🌙</span>
                                <span>哄睡模式设置</span>
                            </div>
                            <button
                                onClick={() => setShowLullabyModal(false)}
                                className="text-white/60 hover:text-white text-lg p-1"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-white/80 font-medium">想要推进的剧情 / 故事内容：</label>
                            <textarea
                                value={lullabyPlot}
                                onChange={(e) => setLullabyPlot(e.target.value)}
                                placeholder="输入你想听的剧情（例如：我们在森林小木屋烤火听雨，回忆过去的事情……）"
                                rows={3}
                                className="w-full text-xs p-2.5 rounded-xl bg-white/10 border border-white/10 focus:outline-none focus:border-indigo-400 placeholder:text-white/35 resize-none text-white"
                            />
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-white/80 font-medium">字数设置（支持长篇）：</label>
                            <div className="grid grid-cols-4 gap-1.5 mb-1">
                                {[
                                    { label: "500字", val: "500" },
                                    { label: "1000字", val: "1000" },
                                    { label: "3000字", val: "3000" },
                                    { label: "5000字", val: "5000" },
                                ].map((item) => (
                                    <button
                                        key={item.val}
                                        type="button"
                                        onClick={() => setLullabyLength(item.val)}
                                        className={`py-1 text-xs rounded-lg transition-all ${lullabyLength === item.val ? "bg-indigo-600 text-white font-semibold" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-2 bg-white/10 px-2.5 py-1.5 rounded-lg border border-white/10">
                                <span className="text-xs text-white/60">自定义字数:</span>
                                <input
                                    type="number"
                                    value={lullabyLength}
                                    onChange={(e) => setLullabyLength(e.target.value)}
                                    placeholder="5000"
                                    className="flex-1 bg-transparent text-xs text-white focus:outline-none"
                                />
                                <span className="text-xs text-white/60">字</span>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-white/80 font-medium">额外补充要求（可选）：</label>
                            <input
                                type="text"
                                value={lullabyCustomPrompt}
                                onChange={(e) => setLullabyCustomPrompt(e.target.value)}
                                placeholder="如：语速放慢、多一些呼吸声……"
                                className="w-full text-xs p-2 rounded-lg bg-white/10 border border-white/10 focus:outline-none focus:border-indigo-400 placeholder:text-white/35 text-white"
                            />
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-white/80 font-medium">⏱ 定时自动挂断（安心入睡）：</label>
                            <div className="grid grid-cols-4 gap-1.5 mb-1">
                                {[
                                    { label: "15分钟", val: "15" },
                                    { label: "30分钟", val: "30" },
                                    { label: "60分钟", val: "60" },
                                    { label: "不自动挂", val: "0" },
                                ].map((item) => (
                                    <button
                                        key={item.val}
                                        type="button"
                                        onClick={() => setLullabyAutoHangupMinutes(item.val)}
                                        className={`py-1 text-xs rounded-lg transition-all ${lullabyAutoHangupMinutes === item.val ? "bg-indigo-600 text-white font-semibold" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-2 bg-white/10 px-2.5 py-1.5 rounded-lg border border-white/10">
                                <span className="text-xs text-white/60">自定义分钟:</span>
                                <input
                                    type="number"
                                    value={lullabyAutoHangupMinutes}
                                    onChange={(e) => setLullabyAutoHangupMinutes(e.target.value)}
                                    placeholder="30"
                                    className="flex-1 bg-transparent text-xs text-white focus:outline-none"
                                />
                                <span className="text-xs text-white/60">分钟（0为不自动挂断）</span>
                            </div>
                        </div>

                        <div className="flex gap-2 pt-2">
                            <button
                                onClick={() => setShowLullabyModal(false)}
                                className="flex-1 py-2 text-xs rounded-xl bg-white/10 hover:bg-white/20 text-white/80 font-medium transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleStartLullaby}
                                className="flex-1 py-2 text-xs rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow-lg shadow-indigo-500/30 transition-colors"
                            >
                                开启长篇哄睡 ✨
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}
