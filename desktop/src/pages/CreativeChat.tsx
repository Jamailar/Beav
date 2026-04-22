import { useEffect, useState, useCallback, useRef } from 'react';
import { MessageSquarePlus, Plus, X, MoreVertical, UserPlus, UserMinus, Pencil, Check, Trash2, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    blobToBase64,
    buildChatModelOptions,
    ChatComposer,
    type ChatComposerHandle,
    type ChatModelOption,
    type ChatSettingsSnapshot,
    type UploadedFileAttachment,
} from '../components/ChatComposer';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { appAlert } from '../utils/appDialogs';

interface Advisor {
    id: string;
    name: string;
    avatar?: string;
    personality: string;
}

interface ChatRoom {
    id: string;
    name: string;
    advisorIds?: string[];
    createdAt: string;
    isSystem?: boolean;
    systemType?: string;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'advisor' | 'director';
    advisorId?: string;
    advisorName?: string;
    advisorAvatar?: string;
    content: string;
    timestamp: string;
    isStreaming?: boolean;
    ragInfo?: { method: string; sources: string[] };
    phase?: 'introduction' | 'discussion' | 'summary';
}

export type CreativeChatAdvisor = Advisor;
export type CreativeChatRoom = ChatRoom;

// 总监常量
const DIRECTOR_ID = 'director-system';
const DIRECTOR_NAME = '总监';
const DIRECTOR_AVATAR = '🎯';

// 六顶思考帽常量
const SIX_HATS_ROOM_ID = 'system_six_thinking_hats';
const SIX_THINKING_HATS = [
    { id: 'hat_white', name: '白帽', avatar: '⚪', color: 'bg-gray-100 border-gray-300', personality: '客观事实' },
    { id: 'hat_red', name: '红帽', avatar: '🔴', color: 'bg-red-100 border-red-300', personality: '情感直觉' },
    { id: 'hat_black', name: '黑帽', avatar: '⚫', color: 'bg-gray-800 border-gray-600', personality: '谨慎批判' },
    { id: 'hat_yellow', name: '黄帽', avatar: '🟡', color: 'bg-yellow-100 border-yellow-300', personality: '积极乐观' },
    { id: 'hat_green', name: '绿帽', avatar: '🟢', color: 'bg-green-100 border-green-300', personality: '创意创新' },
    { id: 'hat_blue', name: '蓝帽', avatar: '🔵', color: 'bg-blue-100 border-blue-300', personality: '总结统筹' },
];
const SIX_HAT_IDS = new Set(SIX_THINKING_HATS.map((hat) => hat.id));
const SIX_HAT_DOT_CLASS: Record<string, string> = {
    hat_white: 'bg-white border border-gray-300',
    hat_red: 'bg-red-500',
    hat_black: 'bg-gray-900',
    hat_yellow: 'bg-yellow-400',
    hat_green: 'bg-green-500',
    hat_blue: 'bg-blue-500',
};
const EMOJI_FONT_FAMILY = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

const isLikelyEmojiAvatar = (avatar: string): boolean => {
    const normalized = String(avatar || '').trim();
    if (!normalized) return false;
    try {
        return /\p{Extended_Pictographic}/u.test(normalized);
    } catch {
        return /[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/.test(normalized);
    }
};

const renderAvatarText = (avatar: string, className?: string) => {
    const value = String(avatar || '').trim() || '🤖';
    const isEmoji = isLikelyEmojiAvatar(value);
    return (
        <span
            className={clsx('leading-none select-none', isEmoji ? 'font-normal' : 'font-medium', className)}
            style={isEmoji ? { fontFamily: EMOJI_FONT_FAMILY } : undefined}
        >
            {value}
        </span>
    );
};

const AVATAR_COLORS = [
    'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-orange-500',
    'bg-green-500', 'bg-teal-500', 'bg-indigo-500', 'bg-rose-500'
];
const STREAM_FLUSH_INTERVAL_MS = 120;

interface CreativeChatProps {
    activeFile?: { path: string; content: string };
    isActive?: boolean;
    onExecutionStateChange?: (active: boolean) => void;
    hideRoomList?: boolean;
    selectedRoomId?: string | null;
    onSelectedRoomIdChange?: (roomId: string | null) => void;
    onRoomsChange?: (rooms: ChatRoom[]) => void;
    createRequestKey?: number;
}

export function CreativeChat({
    activeFile,
    isActive = true,
    onExecutionStateChange,
    hideRoomList = false,
    selectedRoomId,
    onSelectedRoomIdChange,
    onRoomsChange,
    createRequestKey,
}: CreativeChatProps) {
    const [rooms, setRooms] = useState<ChatRoom[]>([]);
    const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [advisors, setAdvisors] = useState<Advisor[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isManageModalOpen, setIsManageModalOpen] = useState(false);
    const [errorNotice, setErrorNotice] = useState<string | null>(null);
    const [pendingAttachment, setPendingAttachment] = useState<UploadedFileAttachment | null>(null);
    const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
    const [selectedChatModelKey, setSelectedChatModelKey] = useState('');
    const [isRecordingAudio, setIsRecordingAudio] = useState(false);
    const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
    const [pendingRoomClear, setPendingRoomClear] = useState<ChatRoom | null>(null);
    const [pendingRoomDelete, setPendingRoomDelete] = useState<ChatRoom | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<ChatComposerHandle>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaChunksRef = useRef<Blob[]>([]);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const selectedRoomIdRef = useRef<string | null>(null);
    const selectedRoomRef = useRef<ChatRoom | null>(null);
    const roomsRef = useRef<ChatRoom[]>([]);
    const advisorsRef = useRef<Advisor[]>([]);
    const isActiveRef = useRef<boolean>(isActive);
    const loadRoomsRequestRef = useRef(0);
    const loadMessagesRequestRef = useRef(0);
    const hasRoomsSnapshotRef = useRef(false);
    const createRequestKeyRef = useRef<number | undefined>(createRequestKey);
    const pendingStreamMapRef = useRef<Record<string, {
        roomId?: string;
        advisorId: string;
        advisorName?: string;
        advisorAvatar?: string;
        content: string;
        done: boolean;
    }>>({});
    const streamFlushTimerRef = useRef<number | null>(null);
    const isSixHatAdvisor = useCallback((advisorId?: string) => {
        return SIX_HAT_IDS.has(String(advisorId || '').trim());
    }, []);

    useEffect(() => {
        onExecutionStateChange?.(isSending);
    }, [isSending, onExecutionStateChange]);

    useEffect(() => {
        return () => {
            onExecutionStateChange?.(false);
        };
    }, [onExecutionStateChange]);

    const getSafeAdvisorIds = useCallback((room?: ChatRoom | null): string[] => {
        if (!room || !Array.isArray(room.advisorIds)) return [];
        return room.advisorIds.map((id) => String(id || '').trim()).filter(Boolean);
    }, []);

    const normalizeAdvisors = useCallback((advisorList: Advisor[] | null | undefined): Advisor[] => {
        return (advisorList || [])
            .filter((advisor): advisor is Advisor => Boolean(advisor && typeof advisor === 'object' && typeof advisor.id === 'string' && advisor.id.trim()))
            .map((advisor) => ({
                ...advisor,
                name: String(advisor.name || '未命名成员').trim() || '未命名成员',
                avatar: String(advisor.avatar || '🤖'),
                personality: String(advisor.personality || ''),
            }));
    }, []);

    const loadAdvisorsOnly = useCallback(async () => {
        try {
            const advisorList = await window.ipcRenderer.advisors.list<Advisor>();
            setAdvisors(normalizeAdvisors(advisorList));
        } catch (e) {
            console.error('Failed to refresh advisors:', e);
        }
    }, [normalizeAdvisors]);

    const loadRooms = useCallback(async () => {
        const requestId = loadRoomsRequestRef.current + 1;
        loadRoomsRequestRef.current = requestId;
        const hasLocalData = hasRoomsSnapshotRef.current || roomsRef.current.length > 0 || advisorsRef.current.length > 0;
        if (!hasLocalData) {
            setIsLoading(true);
        }
        try {
            const [roomList, advisorList] = await Promise.all([
                window.ipcRenderer.invoke('chatrooms:list') as Promise<ChatRoom[]>,
                window.ipcRenderer.advisors.list<Advisor>()
            ]);
            const normalizedRooms = (roomList || [])
                .filter((room): room is ChatRoom => Boolean(room && typeof room === 'object' && typeof room.id === 'string' && room.id.trim()))
                .map((room) => ({
                    ...room,
                    name: String(room.name || '未命名群聊').trim() || '未命名群聊',
                    advisorIds: getSafeAdvisorIds(room),
                }));
            const normalizedAdvisors = normalizeAdvisors(advisorList);
            if (requestId !== loadRoomsRequestRef.current) {
                return;
            }
            setRooms(normalizedRooms);
            setAdvisors(normalizedAdvisors);
            setSelectedRoom((prev) => {
                if (!prev) return prev;
                return normalizedRooms.find((room) => room.id === prev.id) || null;
            });
            hasRoomsSnapshotRef.current = true;
        } catch (e) {
            if (requestId !== loadRoomsRequestRef.current) {
                return;
            }
            console.error('Failed to load rooms:', e);
        } finally {
            if (requestId === loadRoomsRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, [getSafeAdvisorIds, normalizeAdvisors]);

    const loadMessages = useCallback(async (roomId: string) => {
        const requestId = loadMessagesRequestRef.current + 1;
        loadMessagesRequestRef.current = requestId;
        try {
            const msgs = await window.ipcRenderer.invoke('chatrooms:messages', roomId) as ChatMessage[];
            if (requestId !== loadMessagesRequestRef.current) return;
            if (selectedRoomIdRef.current && selectedRoomIdRef.current !== roomId) return;
            const next = Array.isArray(msgs) ? [...msgs] : [];
            next.sort((a, b) => {
                const leftTime = String(a?.timestamp || '');
                const rightTime = String(b?.timestamp || '');
                if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
                return String(a?.id || '').localeCompare(String(b?.id || ''));
            });
            setMessages(next);
            // 首次加载时直接定位到底部（无动画）
            setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
            }, 0);
        } catch (e) {
            console.error('Failed to load messages:', e);
        }
    }, []);

    useEffect(() => {
        isActiveRef.current = isActive;
    }, [isActive]);

    useEffect(() => {
        if (!isActive) return;
        void loadRooms();
        if (selectedRoomRef.current?.id) {
            void loadMessages(selectedRoomRef.current.id);
        }
    }, [isActive, loadMessages, loadRooms]);

    useEffect(() => {
        if (!isActive) return;
        const handleAdvisorsChanged = () => {
            void loadAdvisorsOnly();
        };
        window.ipcRenderer.on('advisors:changed', handleAdvisorsChanged);
        return () => {
            window.ipcRenderer.off('advisors:changed', handleAdvisorsChanged);
        };
    }, [isActive, loadAdvisorsOnly]);

    useEffect(() => {
        if (!isActive) return;
        if (selectedRoom) {
            void loadMessages(selectedRoom.id);
        }
    }, [isActive, selectedRoom, loadMessages]);

    useEffect(() => {
        selectedRoomIdRef.current = selectedRoom?.id || null;
        selectedRoomRef.current = selectedRoom;
    }, [selectedRoom]);

    useEffect(() => {
        roomsRef.current = rooms;
    }, [rooms]);

    useEffect(() => {
        advisorsRef.current = advisors;
    }, [advisors]);

    useEffect(() => {
        onRoomsChange?.(rooms);
    }, [onRoomsChange, rooms]);

    useEffect(() => {
        if (createRequestKey === undefined) return;
        if (createRequestKeyRef.current === createRequestKey) return;
        createRequestKeyRef.current = createRequestKey;
        setIsCreateModalOpen(true);
    }, [createRequestKey]);

    // 流式消息只做即时滚动，避免每个 chunk 触发 smooth scroll 造成主线程卡顿
    const hasStreamingMessage = messages.some(m => m.isStreaming);
    useEffect(() => {
        if (hasStreamingMessage) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        }
    }, [messages, hasStreamingMessage]);

    const selectedChatModel = chatModelOptions.find((item) => item.key === selectedChatModelKey) || null;

    const clearPendingAttachment = useCallback(() => {
        setPendingAttachment(null);
        requestAnimationFrame(() => {
            composerRef.current?.focus();
            composerRef.current?.syncHeight();
        });
    }, []);

    const loadChatModelOptions = useCallback(async () => {
        if (!isActiveRef.current) return;
        try {
            const settings = await window.ipcRenderer.getSettings() as ChatSettingsSnapshot | undefined;
            const options = buildChatModelOptions(settings);
            setChatModelOptions(options);
            setSelectedChatModelKey((current) => {
                if (current && options.some((item) => item.key === current)) return current;
                return options.find((item) => item.isDefault)?.key || options[0]?.key || '';
            });
        } catch (error) {
            console.error('Failed to load creative chat model options:', error);
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadChatModelOptions();
    }, [isActive, loadChatModelOptions]);

    const cleanupAudioCapture = useCallback(() => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.ondataavailable = null;
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current.onerror = null;
            mediaRecorderRef.current = null;
        }
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            mediaStreamRef.current = null;
        }
        mediaChunksRef.current = [];
    }, []);

    useEffect(() => {
        return () => {
            cleanupAudioCapture();
        };
    }, [cleanupAudioCapture]);

    const pickAttachment = useCallback(async () => {
        if (isSending) return;
        try {
            const result = await window.ipcRenderer.chat.pickAttachment({
                sessionId: selectedRoom?.id || undefined,
            }) as { success?: boolean; canceled?: boolean; error?: string; attachment?: UploadedFileAttachment };
            if (!result?.success) {
                setErrorNotice(result?.error || '上传文件失败');
                return;
            }
            if (result.canceled) return;
            if (result.attachment) {
                setErrorNotice(null);
                setPendingAttachment(result.attachment);
                requestAnimationFrame(() => {
                    composerRef.current?.syncHeight();
                    composerRef.current?.focus();
                });
            }
        } catch (error) {
            setErrorNotice(String(error || '上传文件失败'));
        }
    }, [isSending, selectedRoom?.id]);

    const getChatModelConfig = useCallback(() => {
        if (!selectedChatModel) return undefined;
        return {
            apiKey: selectedChatModel.apiKey,
            baseURL: selectedChatModel.baseURL,
            modelName: selectedChatModel.modelName,
        };
    }, [selectedChatModel]);

    const transcribeAudioBlob = useCallback(async (blob: Blob) => {
        setIsTranscribingAudio(true);
        setErrorNotice(null);
        try {
            const audioBase64 = await blobToBase64(blob);
            const result = await window.ipcRenderer.chat.transcribeAudio({
                audioBase64,
                mimeType: blob.type || 'audio/webm',
                fileName: `creative_chat_audio_${Date.now()}.webm`,
            });
            if (!result?.success || !String(result.text || '').trim()) {
                throw new Error(result?.error || '语音转文字失败');
            }
            setInputValue((prev) => {
                const current = String(prev || '').trim();
                const next = String(result.text || '').trim();
                return current ? `${current}${current.endsWith('\n') ? '' : '\n'}${next}` : next;
            });
            requestAnimationFrame(() => {
                composerRef.current?.focus();
                composerRef.current?.syncHeight();
            });
        } catch (error) {
            setErrorNotice(error instanceof Error ? error.message : String(error));
        } finally {
            setIsTranscribingAudio(false);
        }
    }, []);

    const stopAudioRecording = useCallback(() => {
        const recorder = mediaRecorderRef.current;
        if (!recorder) return;
        if (recorder.state !== 'inactive') {
            recorder.stop();
        } else {
            cleanupAudioCapture();
            setIsRecordingAudio(false);
        }
    }, [cleanupAudioCapture]);

    const startAudioRecording = useCallback(async () => {
        if (isSending || isTranscribingAudio) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            setErrorNotice('当前环境不支持麦克风录音');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const preferredMimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';
            const recorder = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
            mediaStreamRef.current = stream;
            mediaRecorderRef.current = recorder;
            mediaChunksRef.current = [];

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    mediaChunksRef.current.push(event.data);
                }
            };
            recorder.onerror = () => {
                setErrorNotice('录音失败，请检查麦克风权限');
                cleanupAudioCapture();
                setIsRecordingAudio(false);
            };
            recorder.onstop = () => {
                const chunks = [...mediaChunksRef.current];
                cleanupAudioCapture();
                setIsRecordingAudio(false);
                if (!chunks.length) return;
                void transcribeAudioBlob(new Blob(chunks, { type: recorder.mimeType || preferredMimeType || 'audio/webm' }));
            };

            recorder.start();
            setIsRecordingAudio(true);
            setErrorNotice(null);
        } catch (error) {
            cleanupAudioCapture();
            setIsRecordingAudio(false);
            setErrorNotice(error instanceof Error ? error.message : '无法访问麦克风');
        }
    }, [cleanupAudioCapture, isSending, isTranscribingAudio, transcribeAudioBlob]);

    const handleAudioInput = useCallback(() => {
        if (isRecordingAudio) {
            stopAudioRecording();
            return;
        }
        void startAudioRecording();
    }, [isRecordingAudio, startAudioRecording, stopAudioRecording]);

    const handleCancelSend = useCallback(async () => {
        if (!selectedRoom) return;
        try {
            await window.ipcRenderer.invoke('chatrooms:cancel', { roomId: selectedRoom.id });
        } catch (error) {
            console.error('Failed to cancel creative chat:', error);
        }
        setIsSending(false);
        setThinkingState({});
        setMessages((prev) => prev.map((msg) => msg.isStreaming ? { ...msg, isStreaming: false } : msg));
    }, [selectedRoom]);

    // Thinking chain state per advisor
    const [thinkingState, setThinkingState] = useState<Record<string, {
        isThinking: boolean;
        content: string;
        ragSources?: string[];
        tools?: { name: string; status: 'running' | 'done'; result?: string }[];
    }>>({});

    const flushBufferedStreams = useCallback(() => {
        streamFlushTimerRef.current = null;
        const pending = Object.values(pendingStreamMapRef.current);
        if (pending.length === 0) return;
        pendingStreamMapRef.current = {};

        const activeRoomId = selectedRoomIdRef.current;
        setMessages(prev => {
            let next = [...prev];
            for (const data of pending) {
                if (data.roomId && activeRoomId && data.roomId !== activeRoomId) {
                    continue;
                }
                let lastMsgIdx = -1;
                for (let i = next.length - 1; i >= 0; i -= 1) {
                    if (next[i].advisorId === data.advisorId && next[i].isStreaming) {
                        lastMsgIdx = i;
                        break;
                    }
                }
                if (lastMsgIdx !== -1) {
                    next[lastMsgIdx] = {
                        ...next[lastMsgIdx],
                        content: next[lastMsgIdx].content + data.content,
                        isStreaming: !data.done,
                    };
                    continue;
                }
                const isDirector = data.advisorId === DIRECTOR_ID;
                next.push({
                    id: `msg_${Date.now()}_${data.advisorId}_stream`,
                    role: isDirector ? 'director' : 'advisor',
                    advisorId: data.advisorId,
                    advisorName: data.advisorName || (isDirector ? DIRECTOR_NAME : '成员'),
                    advisorAvatar: data.advisorAvatar || (isDirector ? DIRECTOR_AVATAR : '🤖'),
                    content: data.content || '',
                    timestamp: new Date().toISOString(),
                    isStreaming: !data.done,
                });
            }
            return next;
        });

        const completedAdvisorIds = pending
            .filter((item) => item.done)
            .map((item) => item.advisorId);
        if (completedAdvisorIds.length > 0) {
            setThinkingState(prev => {
                const next = { ...prev };
                for (const advisorId of completedAdvisorIds) {
                    next[advisorId] = { ...next[advisorId], isThinking: false };
                }
                return next;
            });
        }
    }, []);

    const scheduleBufferedStreamFlush = useCallback(() => {
        if (streamFlushTimerRef.current !== null) return;
        streamFlushTimerRef.current = window.setTimeout(() => {
            flushBufferedStreams();
        }, STREAM_FLUSH_INTERVAL_MS);
    }, [flushBufferedStreams]);

    // Listen for streaming responses through unified runtime:event only
    useEffect(() => {
        const handleCreativeChatError = (data?: { roomId?: string; message?: string }) => {
            if (data?.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }
            console.error('Creative chat execution failed:', data?.message || 'unknown error');
            setIsSending(false);
        };

        // 处理从其他页面发送的用户消息
        const handleUserMessage = (data: { roomId: string; message: ChatMessage }) => {
            if (!isActiveRef.current) return;
            // 如果当前选中的房间就是消息所属的房间，添加到消息列表
            if (selectedRoomIdRef.current === data.roomId) {
                setMessages(prev => {
                    // 避免重复添加
                    if (prev.some(m => m.id === data.message.id)) return prev;
                    if (data.message.role === 'user' && prev.some((m) => {
                        if (m.role !== 'user') return false;
                        if (String(m.content || '').trim() !== String(data.message.content || '').trim()) return false;
                        const leftTs = Date.parse(String(m.timestamp || ''));
                        const rightTs = Date.parse(String(data.message.timestamp || ''));
                        if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) return false;
                        return Math.abs(leftTs - rightTs) <= 5000;
                    })) {
                        return prev;
                    }
                    return [...prev, data.message];
                });
            }
            // 如果当前没有选中房间，自动选中这个房间
            if (!selectedRoomRef.current) {
                // 重新加载房间列表并选中
                loadRooms().then(() => {
                    const targetRoom = roomsRef.current.find(r => r.id === data.roomId);
                    if (targetRoom) {
                        setSelectedRoom(targetRoom);
                        loadMessages(data.roomId);
                    }
                });
            }
        };

        const handleStream = (data: { roomId?: string; advisorId: string; advisorName?: string; advisorAvatar?: string; content: string; done: boolean }) => {
            if (!isActiveRef.current) return;
            if (data.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }
            const key = `${data.roomId || selectedRoomIdRef.current || 'room'}:${data.advisorId}`;
            const existing = pendingStreamMapRef.current[key];
            pendingStreamMapRef.current[key] = {
                roomId: data.roomId,
                advisorId: data.advisorId,
                advisorName: data.advisorName,
                advisorAvatar: data.advisorAvatar,
                content: `${existing?.content || ''}${data.content || ''}`,
                done: Boolean(data.done),
            };
            scheduleBufferedStreamFlush();
        };

        const handleNewAdvisor = (data: { roomId?: string; advisorId: string; advisorName: string; advisorAvatar: string; phase?: string }) => {
            if (!isActiveRef.current) return;
            if (data.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }

            // Prevent duplicate: check if already have a streaming msg for this advisor
            setMessages(prev => {
                const exists = prev.some(m => m.advisorId === data.advisorId && m.isStreaming);
                if (exists) return prev;

                // 判断是否是总监
                const isDirector = data.advisorId === DIRECTOR_ID;

                const newMsg: ChatMessage = {
                    id: `msg_${Date.now()}_${data.advisorId}`,
                    role: isDirector ? 'director' : 'advisor',
                    advisorId: data.advisorId,
                    advisorName: data.advisorName,
                    advisorAvatar: data.advisorAvatar,
                    content: '',
                    timestamp: new Date().toISOString(),
                    isStreaming: true,
                    phase: data.phase as ChatMessage['phase'],
                };
                return [...prev, newMsg];
            });

            // Initialize thinking state
            setThinkingState(prev => ({
                ...prev,
                [data.advisorId]: { isThinking: true, content: '开始分析...', tools: [] }
            }));
        };

        const handleThinking = (data: { roomId?: string; advisorId: string; type: string; content: string }) => {
            if (!isActiveRef.current) return;
            if (data?.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }

            setThinkingState(prev => ({
                ...prev,
                [data.advisorId]: {
                    ...prev[data.advisorId],
                    isThinking: data.type !== 'thinking_end',
                    content: data.content || prev[data.advisorId]?.content || '',
                }
            }));
        };

        const handleRag = (data: { roomId?: string; advisorId: string; type: string; content?: string; sources?: string[] }) => {
            if (!isActiveRef.current) return;
            if (data?.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }

            setThinkingState(prev => ({
                ...prev,
                [data.advisorId]: {
                    ...prev[data.advisorId],
                    content: data.type === 'rag_start' ? '正在检索知识库...' : (data.content || prev[data.advisorId]?.content || ''),
                    ragSources: data.sources || prev[data.advisorId]?.ragSources,
                }
            }));
        };

        const handleTool = (data: { roomId?: string; advisorId: string; type: string; tool: { name: string; result?: { success: boolean; content: string } } }) => {
            if (!isActiveRef.current) return;
            if (data?.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }

            setThinkingState(prev => {
                const current = prev[data.advisorId] || { isThinking: true, content: '', tools: [] };
                const tools = [...(current.tools || [])];

                if (data.type === 'tool_start') {
                    tools.push({ name: data.tool.name, status: 'running' });
                } else if (data.type === 'tool_end') {
                    const idx = tools.findIndex(t => t.name === data.tool.name && t.status === 'running');
                    if (idx !== -1) {
                        tools[idx] = {
                            ...tools[idx],
                            status: 'done',
                            result: data.tool.result?.content
                        };
                    }
                }

                return {
                    ...prev,
                    [data.advisorId]: { ...current, tools }
                };
            });
        };

        const handleDone = (data?: { roomId?: string }) => {
            flushBufferedStreams();
            setIsSending(false);
            if (!isActiveRef.current) return;
            if (data?.roomId && selectedRoomIdRef.current && data.roomId !== selectedRoomIdRef.current) {
                return;
            }
            setMessages(prev => prev.map(msg => msg.isStreaming ? { ...msg, isStreaming: false } : msg));
            // Reset all thinking states
            setThinkingState({});
        };
        if (!isActive) {
            return;
        }

        const disposeRuntimeEvents = subscribeRuntimeEventStream({
            onCreativeChatUserMessage: ({ roomId, message }) => {
                handleUserMessage({
                    roomId,
                    message: message as unknown as ChatMessage,
                });
            },
            onCreativeChatStream: ({ roomId, advisorId, advisorName, advisorAvatar, content, done }) => {
                handleStream({
                    roomId,
                    advisorId,
                    advisorName,
                    advisorAvatar,
                    content,
                    done,
                });
            },
            onCreativeChatAdvisorStart: ({ roomId, advisorId, advisorName, advisorAvatar, phase }) => {
                handleNewAdvisor({
                    roomId,
                    advisorId,
                    advisorName,
                    advisorAvatar,
                    phase,
                });
            },
            onCreativeChatThinking: ({ roomId, advisorId, thinkingType, content }) => {
                handleThinking({
                    roomId,
                    advisorId,
                    type: thinkingType,
                    content,
                });
            },
            onCreativeChatRag: ({ roomId, advisorId, ragType, content, sources }) => {
                handleRag({
                    roomId,
                    advisorId,
                    type: ragType,
                    content,
                    sources,
                });
            },
            onCreativeChatTool: ({ roomId, advisorId, toolType, tool }) => {
                handleTool({
                    roomId,
                    advisorId,
                    type: toolType,
                    tool: tool as unknown as { name: string; result?: { success: boolean; content: string } },
                });
            },
            onCreativeChatDone: ({ roomId }) => {
                handleDone({ roomId });
            },
            onCreativeChatError: ({ roomId, error }) => {
                handleCreativeChatError({
                    roomId,
                    message: String((error as { message?: unknown })?.message || ''),
                });
            },
        });

        return () => {
            if (streamFlushTimerRef.current !== null) {
                window.clearTimeout(streamFlushTimerRef.current);
                streamFlushTimerRef.current = null;
            }
            disposeRuntimeEvents();
        };
    }, [flushBufferedStreams, isActive, loadMessages, loadRooms, scheduleBufferedStreamFlush]);


    const handleSelectRoom = useCallback((room: ChatRoom) => {
        selectedRoomIdRef.current = room.id;
        selectedRoomRef.current = room;
        setSelectedRoom(room);
        setMessages([]);
        onSelectedRoomIdChange?.(room.id);
    }, [onSelectedRoomIdChange]);

    useEffect(() => {
        if (selectedRoomId === undefined) return;
        if (!selectedRoomId) {
            if (selectedRoomRef.current) {
                selectedRoomIdRef.current = null;
                selectedRoomRef.current = null;
                setSelectedRoom(null);
                setMessages([]);
            }
            return;
        }

        if (selectedRoomRef.current?.id === selectedRoomId) return;
        const matchedRoom = rooms.find((room) => room.id === selectedRoomId);
        if (matchedRoom) {
            handleSelectRoom(matchedRoom);
        }
    }, [handleSelectRoom, rooms, selectedRoomId]);

    const handleSendMessage = async () => {
        const normalizedContent = String(inputValue || '').trim();
        const attachment = pendingAttachment;
        const displayText = normalizedContent || (attachment ? `请分析这个附件：${attachment.name}` : '');
        if (!displayText || !selectedRoom || isSending) return;

        const clientMessageId = `msg_${Date.now()}`;
        const userMessage: ChatMessage = {
            id: clientMessageId,
            role: 'user',
            content: displayText,
            timestamp: new Date().toISOString()
        };

        setMessages(prev => [...prev, userMessage]);
        setInputValue('');
        setPendingAttachment(null);
        setErrorNotice(null);
        setIsSending(true);
        composerRef.current?.resetHeight();

        try {
            const targetRoomId = selectedRoom.id;
            const contextPayload: Record<string, unknown> = {};
            if (activeFile) {
                contextPayload.activeFile = {
                    filePath: activeFile.path,
                    fileContent: activeFile.content.substring(0, 10000),
                };
            }
            if (attachment) {
                contextPayload.attachment = attachment;
            }
            window.ipcRenderer.send('chatrooms:send', {
                roomId: targetRoomId,
                message: displayText,
                clientMessageId,
                context: Object.keys(contextPayload).length > 0 ? contextPayload : undefined,
                modelConfig: getChatModelConfig(),
            });
        } catch (e) {
            console.error('Failed to send message:', e);
            setErrorNotice('发送消息失败');
            setIsSending(false);
        }
    };

    const handleCreateRoom = async (name: string, advisorIds: string[]) => {
        try {
            const newRoom = await window.ipcRenderer.invoke('chatrooms:create', { name, advisorIds }) as ChatRoom;
            setRooms(prev => [...prev, newRoom]);
            setSelectedRoom(newRoom);
            onSelectedRoomIdChange?.(newRoom.id);
            setIsCreateModalOpen(false);
        } catch (e) {
            console.error('Failed to create room:', e);
        }
    };

    const handleDeleteRoom = async () => {
        if (!selectedRoom) return;

        try {
            await window.ipcRenderer.invoke('chatrooms:delete', selectedRoom.id);
            setRooms(prev => prev.filter(r => r.id !== selectedRoom.id));
            setSelectedRoom(null);
            onSelectedRoomIdChange?.(null);
            setMessages([]);
            setIsManageModalOpen(false);
            setPendingRoomDelete(null);
        } catch (e) {
            console.error('Failed to delete room:', e);
        }
    };

    const handleClearMessages = async () => {
        if (!selectedRoom) return;

        try {
            const res = await window.ipcRenderer.invoke('chatrooms:clear', selectedRoom.id) as { success: boolean };
            if (res?.success) {
                setMessages([]);
                setThinkingState({});
            }
            setPendingRoomClear(null);
        } catch (e) {
            console.error('Failed to clear messages:', e);
        }
    };

    const handleUpdateRoom = async (name: string, advisorIds: string[]) => {
        if (!selectedRoom) return;

        try {
            const result = await window.ipcRenderer.invoke('chatrooms:update', {
                roomId: selectedRoom.id,
                name,
                advisorIds
            }) as { success: boolean; room?: ChatRoom };

            if (result.success && result.room) {
                setRooms(prev => prev.map(r => r.id === selectedRoom.id ? result.room! : r));
                setSelectedRoom(result.room);
                onSelectedRoomIdChange?.(result.room.id);
            }
            setIsManageModalOpen(false);
        } catch (e) {
            console.error('Failed to update room:', e);
        }
    };

    const getAdvisorColor = (advisorId: string) => {
        // 总监使用特殊颜色
        if (advisorId === DIRECTOR_ID) {
            return 'bg-gradient-to-br from-amber-500 to-orange-600';
        }
        const idx = parseInt(advisorId.slice(-1), 16) % AVATAR_COLORS.length;
        return AVATAR_COLORS[idx];
    };

    const getPhaseLabel = (phase?: string) => {
        switch (phase) {
            case 'introduction': return '📋 问题分析';
            case 'discussion': return '💬 观点分享';
            case 'summary': return '📊 总结对比';
            default: return '';
        }
    };

    const getRoomAdvisors = (room: ChatRoom) => {
        const advisorIds = getSafeAdvisorIds(room);
        return advisors.filter(a => advisorIds.includes(a.id));
    };

    // 获取房间所有成员（包括总监）
    const getRoomMembers = (room: ChatRoom) => {
        // 六顶思考帽模式：使用预定义的帽子角色
        if (room.isSystem && room.systemType === 'six_thinking_hats') {
            return SIX_THINKING_HATS.map(h => ({
                id: h.id,
                name: h.name,
                avatar: h.avatar,
                personality: h.personality
            }));
        }

        // 普通模式：总监 + 智囊团成员
        const advisorIds = getSafeAdvisorIds(room);
        const members = advisors.filter(a => advisorIds.includes(a.id));
        // 总监始终在最前面
        return [
            { id: DIRECTOR_ID, name: DIRECTOR_NAME, avatar: DIRECTOR_AVATAR, personality: '主持讨论' },
            ...members
        ];
    };

    // 检查是否是系统聊天室（不可编辑）
    const isSystemRoom = (room: ChatRoom) => room.isSystem === true;

    // 渲染头像（支持emoji和URL图片）
    const renderAvatar = (avatar: string, size: 'sm' | 'md' | 'lg' = 'sm', className?: string, advisorId?: string) => {
        const sizeClasses = {
            sm: 'w-5 h-5 text-[10px]',
            md: 'w-8 h-8 text-sm',
            lg: 'w-11 h-11 text-lg'
        };
        const dotSizeClasses = {
            sm: 'w-2.5 h-2.5',
            md: 'w-3.5 h-3.5',
            lg: 'w-4 h-4',
        };
        if (isSixHatAdvisor(advisorId)) {
            const dotClass = SIX_HAT_DOT_CLASS[String(advisorId || '').trim()] || 'bg-gray-400';
            return (
                <span className={clsx(sizeClasses[size], 'flex items-center justify-center', className)}>
                    <span className={clsx(dotSizeClasses[size], 'rounded-full', dotClass)} />
                </span>
            );
        }

        if (hasRenderableAssetUrl(avatar)) {
            return (
                <img
                    src={resolveAssetUrl(avatar)}
                    alt=""
                    className={clsx(sizeClasses[size], "rounded-full object-cover", className)}
                />
            );
        }
        return (
            <span className={clsx(sizeClasses[size], "flex items-center justify-center", className)}>
                {renderAvatarText(avatar, size === 'lg' ? 'text-base' : size === 'md' ? 'text-sm' : 'text-[11px]')}
            </span>
        );
    };

    const renderComposer = () => (
        <ChatComposer
            ref={composerRef}
            theme="default"
            variant="main"
            value={inputValue}
            onValueChange={setInputValue}
            onSubmit={() => void handleSendMessage()}
            placeholder="发送消息..."
            attachment={pendingAttachment}
            onPickAttachment={pickAttachment}
            onClearAttachment={clearPendingAttachment}
            modelOptions={chatModelOptions}
            selectedModelKey={selectedChatModelKey}
            onSelectedModelKeyChange={setSelectedChatModelKey}
            isBusy={isSending}
            audioState={isTranscribingAudio ? 'transcribing' : isRecordingAudio ? 'recording' : 'idle'}
            onAudioAction={handleAudioInput}
            onCancel={() => void handleCancelSend()}
            showCancelWhenBusy={true}
        />
    );

    return (
        <div className="flex h-full">
            {!hideRoomList && (
                <div className="w-72 border-r border-border bg-surface-secondary/30 flex flex-col">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-text-primary">创意聊天室</h2>
                        <button
                            onClick={() => setIsCreateModalOpen(true)}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-auto p-2 space-y-2">
                        {isLoading && rooms.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-8">加载中...</div>
                        ) : rooms.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-8">
                                <MessageSquarePlus className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                <p>暂无聊天室</p>
                                <button onClick={() => setIsCreateModalOpen(true)} className="mt-2 text-accent-primary hover:underline">
                                    创建聊天室
                                </button>
                            </div>
                        ) : (
                            rooms.map((room) => (
                                <button
                                    key={room.id}
                                    onClick={() => handleSelectRoom(room)}
                                    className={clsx(
                                        "w-full text-left p-3 rounded-xl transition-all",
                                        selectedRoom?.id === room.id
                                            ? "bg-accent-primary/10 border border-accent-primary/30"
                                            : "hover:bg-surface-primary border border-transparent",
                                        room.isSystem && "ring-1 ring-amber-300/50"
                                    )}
                                >
                                    <div className="flex items-center gap-2">
                                        {room.isSystem && (
                                            <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full font-medium">
                                                🎩
                                            </span>
                                        )}
                                        <span className="text-sm font-medium text-text-primary truncate">{room.name}</span>
                                    </div>
                                    <div className="flex items-center gap-1 mt-1.5">
                                        {getRoomMembers(room).slice(0, 6).map((a) => (
                                            <div
                                                key={a.id}
                                                className={clsx(
                                                    "w-5 h-5 rounded-full flex items-center justify-center overflow-hidden",
                                                    getAdvisorColor(a.id)
                                                )}
                                            >
                                                {renderAvatar(a.avatar || '🤖', 'sm', undefined, a.id)}
                                            </div>
                                        ))}
                                        {getRoomMembers(room).length > 6 && (
                                            <span className="text-[10px] text-text-tertiary">+{getRoomMembers(room).length - 6}</span>
                                        )}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Chat Area */}
            <div className="flex-1 flex flex-col min-w-0">
                {selectedRoom ? (
                    <>
                        {/* Header */}
                        <div className="px-6 py-3 border-b border-border flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2">
                                    {selectedRoom.isSystem && (
                                        <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full font-medium">
                                            🎩 系统
                                        </span>
                                    )}
                                    <h1 className="text-base font-semibold text-text-primary">{selectedRoom.name}</h1>
                                </div>
                                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                    {getRoomMembers(selectedRoom).map((a, i) => (
                                        <span key={a.id} className="flex items-center">
                                            {i > 0 && <span className="text-text-tertiary mx-1">·</span>}
                                            <span className={clsx(
                                                "text-xs",
                                                a.id === DIRECTOR_ID ? "text-amber-600 font-medium" : "text-text-tertiary"
                                            )}>
                                                {a.name}
                                            </span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setPendingRoomClear(selectedRoom)}
                                    className="p-2 text-text-tertiary hover:text-red-500 hover:bg-surface-secondary rounded-lg transition-colors"
                                    title="清空聊天记录"
                                >
                                    <Trash2 className="w-5 h-5" />
                                </button>
                                {/* 六顶思考帽系统群支持直接删除 */}
                                {isSystemRoom(selectedRoom) && (
                                    <button
                                        onClick={() => setPendingRoomDelete(selectedRoom)}
                                        className="p-2 text-text-tertiary hover:text-red-500 hover:bg-surface-secondary rounded-lg transition-colors"
                                        title="删除群聊"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                )}
                                {!isSystemRoom(selectedRoom) && (
                                    <button
                                        onClick={() => setIsManageModalOpen(true)}
                                        className="p-2 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
                                        title="群聊管理"
                                    >
                                        <MoreVertical className="w-5 h-5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 overflow-auto p-6 space-y-4">
                            {messages.map((msg) => (
                                <div key={msg.id} className={clsx("flex gap-3", msg.role === 'user' ? "justify-end" : "")}>
                                    {(msg.role === 'advisor' || msg.role === 'director') && (
                                        <div className={clsx(
                                            "w-8 h-8 rounded-full flex items-center justify-center shrink-0 overflow-hidden",
                                            isSixHatAdvisor(msg.advisorId)
                                                ? 'bg-white border border-border'
                                                : getAdvisorColor(msg.advisorId || ''),
                                            msg.role === 'director' && "ring-2 ring-amber-300 ring-offset-1"
                                        )}>
                                            {isSixHatAdvisor(msg.advisorId) ? (
                                                <span className={clsx('w-3.5 h-3.5 rounded-full', SIX_HAT_DOT_CLASS[String(msg.advisorId || '').trim()] || 'bg-gray-400')} />
                                            ) : hasRenderableAssetUrl(msg.advisorAvatar) ? (
                                                <img src={resolveAssetUrl(msg.advisorAvatar)} alt="" className="w-full h-full object-cover" />
                                            ) : (
                                                renderAvatarText(msg.advisorAvatar || '🤖', 'text-sm')
                                            )}
                                        </div>
                                    )}
                                    <div className={clsx(
                                        "max-w-[70%] rounded-2xl px-4 py-2.5",
                                        msg.role === 'user'
                                            ? "bg-accent-primary text-white"
                                            : msg.role === 'director'
                                            ? "bg-amber-50 border-2 border-amber-200 dark:bg-amber-900/20 dark:border-amber-700"
                                            : "bg-surface-secondary border border-border"
                                    )}>
                                        {(msg.role === 'advisor' || msg.role === 'director') && (
                                            <>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={clsx(
                                                        "text-xs font-medium",
                                                        msg.role === 'director' ? "text-amber-600 dark:text-amber-400" : "text-accent-primary"
                                                    )}>
                                                        {msg.advisorName}
                                                        {msg.role === 'director' && ' 🎯'}
                                                    </span>
                                                    {msg.phase && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary text-text-tertiary">
                                                            {getPhaseLabel(msg.phase)}
                                                        </span>
                                                    )}
                                                </div>
                                                {/* Thinking Chain Display */}
                                                {msg.advisorId && thinkingState[msg.advisorId] && (
                                                    <div className="mb-2 p-2 bg-surface-primary/50 rounded-lg border border-border/50 text-xs">
                                                        {/* Thinking indicator */}
                                                        {thinkingState[msg.advisorId].isThinking && (
                                                            <div className="flex items-center gap-2 text-text-tertiary">
                                                                <div className="flex gap-0.5">
                                                                    <span className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                                    <span className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                                    <span className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                                </div>
                                                                <span>{thinkingState[msg.advisorId].content}</span>
                                                            </div>
                                                        )}
                                                        {/* RAG sources */}
                                                        {thinkingState[msg.advisorId].ragSources !== undefined && (
                                                            <div className={clsx(
                                                                "mt-1.5 flex items-center gap-1 font-medium",
                                                                thinkingState[msg.advisorId].ragSources!.length > 0 ? "text-green-600" : "text-text-tertiary"
                                                            )}>
                                                                <span>{thinkingState[msg.advisorId].ragSources!.length > 0 ? '🔍' : '⚪'}</span>
                                                                <span>
                                                                    {thinkingState[msg.advisorId].ragSources!.length > 0
                                                                        ? `已检索到 ${thinkingState[msg.advisorId].ragSources!.length} 条有效知识`
                                                                        : '未检索到相关知识'
                                                                    }
                                                                </span>
                                                            </div>
                                                        )}
                                                        {/* Tools */}
                                                        {thinkingState[msg.advisorId].tools && thinkingState[msg.advisorId].tools!.length > 0 && (
                                                            <div className="mt-1.5 space-y-1">
                                                                {thinkingState[msg.advisorId].tools!.map((tool, idx) => (
                                                                    <div key={idx} className="flex items-center gap-2">
                                                                        {tool.status === 'running' ? (
                                                                            <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                                                                        ) : (
                                                                            <Check className="w-3 h-3 text-green-500" />
                                                                        )}
                                                                        <span className="text-text-secondary">
                                                                            {tool.name === 'web_search' ? '🔍 网络搜索' :
                                                                                tool.name === 'calculator' ? '🔢 计算' : tool.name}
                                                                        </span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                        {msg.isStreaming ? (
                                            <div className="text-sm whitespace-pre-wrap break-words">
                                                {msg.content}
                                                <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5" />
                                            </div>
                                        ) : (
                                            <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-table:my-2 prose-th:bg-surface-secondary prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border prose-table:border-border prose-th:border prose-th:border-border prose-td:border prose-td:border-border">
                                                {msg.content ? (
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                ) : (
                                                    <span className="text-text-tertiary">(空回复)</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input */}
                        <div className="shrink-0 border-t border-border bg-surface-primary px-4 py-4">
                            {errorNotice && (
                                <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                                    {errorNotice}
                                </div>
                            )}
                            <div className="mx-auto w-full">
                                {renderComposer()}
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-text-tertiary">
                        <div className="text-center">
                            <MessageSquarePlus className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="text-sm">选择或创建一个聊天室</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Create Room Modal */}
            {isCreateModalOpen && (
                <CreateRoomModal
                    advisors={advisors}
                    onSave={handleCreateRoom}
                    onClose={() => setIsCreateModalOpen(false)}
                />
            )}

            {/* Manage Room Modal */}
            {isManageModalOpen && selectedRoom && (
                <ManageRoomModal
                    room={selectedRoom}
                    advisors={advisors}
                    onSave={handleUpdateRoom}
                    onDelete={handleDeleteRoom}
                    onClose={() => setIsManageModalOpen(false)}
                />
            )}

            <ConfirmDialog
                open={Boolean(pendingRoomClear)}
                title="清空聊天记录"
                description={pendingRoomClear ? `确定要清空聊天室“${pendingRoomClear.name}”的聊天记录吗？` : ''}
                confirmLabel="清空"
                tone="danger"
                onCancel={() => setPendingRoomClear(null)}
                onConfirm={() => void handleClearMessages()}
            />

            <ConfirmDialog
                open={Boolean(pendingRoomDelete)}
                title="删除聊天室"
                description={pendingRoomDelete ? `确定要删除聊天室“${pendingRoomDelete.name}”吗？所有聊天记录将被清除。` : ''}
                confirmLabel="删除"
                tone="danger"
                onCancel={() => setPendingRoomDelete(null)}
                onConfirm={() => void handleDeleteRoom()}
            />
        </div>
    );
}

// Create Room Modal
function CreateRoomModal({
    advisors,
    onSave,
    onClose
}: {
    advisors: Advisor[];
    onSave: (name: string, advisorIds: string[]) => void;
    onClose: () => void;
}) {
    const [name, setName] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    const toggleAdvisor = (id: string) => {
        setSelectedIds(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        );
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-md mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <h3 className="text-base font-semibold text-text-primary">创建聊天室</h3>
                    <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="px-6 py-4 space-y-4">
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">🎯 群聊目标</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="例如：选题优化、标题优化、内容创意..."
                            className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                        <p className="text-[10px] text-text-tertiary mt-1">
                            为本群定一个讨论目标，群成员会围绕此目标进行讨论
                        </p>
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-2">
                            邀请智囊团成员 <span className="text-text-tertiary">（已选 {selectedIds.length}）</span>
                        </label>
                        {advisors.length === 0 ? (
                            <p className="text-xs text-text-tertiary">请先在智囊团中创建成员</p>
                        ) : (
                            <div className="grid grid-cols-2 gap-2 max-h-48 overflow-auto">
                                {advisors.map((a) => (
                                    <button
                                        key={a.id}
                                        onClick={() => toggleAdvisor(a.id)}
                                        className={clsx(
                                            "flex items-center gap-2 p-2 rounded-lg border text-left",
                                            selectedIds.includes(a.id)
                                                ? "border-accent-primary bg-accent-primary/10"
                                                : "border-border hover:border-accent-primary/50"
                                        )}
                                    >
                                        <div className={clsx(
                                            "w-7 h-7 rounded-full flex items-center justify-center text-sm overflow-hidden shrink-0",
                                            AVATAR_COLORS[parseInt(a.id.slice(-1), 16) % AVATAR_COLORS.length]
                                        )}>
                                            {hasRenderableAssetUrl(a.avatar) ? (
                                                <img src={resolveAssetUrl(a.avatar)} alt="" className="w-full h-full object-cover" />
                                            ) : (
                                                <span>{a.avatar || '🤖'}</span>
                                            )}
                                        </div>
                                        <span className="text-xs text-text-primary truncate">{a.name}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg">
                        取消
                    </button>
                    <button
                        onClick={() => onSave(name, selectedIds)}
                        disabled={!name.trim() || selectedIds.length === 0}
                        className="px-4 py-2 text-sm text-white bg-accent-primary rounded-lg disabled:opacity-50"
                    >
                        创建
                    </button>
                </div>
            </div>
        </div>
    );
}

// Manage Room Side Panel (WeChat style)
function ManageRoomModal({
    room,
    advisors,
    onSave,
    onDelete,
    onClose
}: {
    room: ChatRoom;
    advisors: Advisor[];
    onSave: (name: string, advisorIds: string[]) => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const [name, setName] = useState(room.name);
    const [selectedIds, setSelectedIds] = useState<string[]>(
        Array.isArray(room.advisorIds)
            ? room.advisorIds.map((id) => String(id || '').trim()).filter(Boolean)
            : []
    );
    const [isEditing, setIsEditing] = useState(false);
    const [showAddPanel, setShowAddPanel] = useState(false);

    // 总监对象
    const director = { id: DIRECTOR_ID, name: DIRECTOR_NAME, avatar: DIRECTOR_AVATAR, personality: '主持讨论' };

    // 当前成员（不包括总监，总监单独显示）
    const currentMembers = advisors.filter(a => selectedIds.includes(a.id));
    const availableToAdd = advisors.filter(a => !selectedIds.includes(a.id));

    // 获取头像颜色
    const getAvatarColor = (id: string) => {
        if (id === DIRECTOR_ID) {
            return 'bg-gradient-to-br from-amber-500 to-orange-600';
        }
        return AVATAR_COLORS[parseInt(id.slice(-1), 16) % AVATAR_COLORS.length];
    };

    // 渲染头像
    const renderMemberAvatar = (avatar: string, className?: string, advisorId?: string) => {
        if (SIX_HAT_IDS.has(String(advisorId || '').trim())) {
            const dotClass = SIX_HAT_DOT_CLASS[String(advisorId || '').trim()] || 'bg-gray-400';
            return (
                <span className={clsx("w-full h-full flex items-center justify-center", className)}>
                    <span className={clsx("w-3.5 h-3.5 rounded-full", dotClass)} />
                </span>
            );
        }
        if (hasRenderableAssetUrl(avatar)) {
            return <img src={resolveAssetUrl(avatar)} alt="" className={clsx("w-full h-full object-cover", className)} />;
        }
        return renderAvatarText(avatar || '🤖', clsx("text-lg", className));
    };

    const removeMember = (id: string) => {
        if (selectedIds.length <= 1) {
            void appAlert('群聊至少需要一个成员');
            return;
        }
        setSelectedIds(prev => prev.filter(i => i !== id));
    };

    const addMember = (id: string) => {
        setSelectedIds(prev => [...prev, id]);
        setShowAddPanel(false);
    };

    const handleSave = () => {
        onSave(name, selectedIds);
    };

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

            {/* Side Panel */}
            <div className="fixed top-0 right-0 h-full w-80 bg-surface-primary shadow-xl z-50 flex flex-col animate-slide-in-right">
                {/* Header */}
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text-primary">聊天信息</h2>
                    <button onClick={onClose} className="p-1 text-text-tertiary hover:text-text-primary">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto">
                    {/* Members Grid */}
                    <div className="p-4 border-b border-border">
                        <div className="flex flex-wrap gap-3">
                            {/* 总监（始终显示在第一位，不可删除） */}
                            <div className="flex flex-col items-center w-14">
                                <div className={clsx(
                                    "w-11 h-11 rounded-lg flex items-center justify-center overflow-hidden ring-2 ring-amber-300",
                                    getAvatarColor(director.id)
                                )}>
                                    {renderMemberAvatar(director.avatar)}
                                </div>
                                <span className="text-[10px] text-amber-600 font-medium mt-1 truncate w-full text-center">{director.name}</span>
                            </div>

                            {/* 其他成员 */}
                            {currentMembers.map((a) => (
                                <div key={a.id} className="flex flex-col items-center w-14 group relative">
                                    <div className={clsx(
                                        "w-11 h-11 rounded-lg flex items-center justify-center overflow-hidden",
                                        getAvatarColor(a.id)
                                    )}>
                                        {renderMemberAvatar(a.avatar || '🤖')}
                                    </div>
                                    <span className="text-[10px] text-text-secondary mt-1 truncate w-full text-center">{a.name}</span>
                                    {/* Remove button */}
                                    <button
                                        onClick={() => removeMember(a.id)}
                                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        <UserMinus className="w-2.5 h-2.5" />
                                    </button>
                                </div>
                            ))}

                            {/* Add Member Button */}
                            <button
                                onClick={() => setShowAddPanel(true)}
                                className="flex flex-col items-center w-14"
                            >
                                <div className="w-11 h-11 rounded-lg border-2 border-dashed border-border flex items-center justify-center text-text-tertiary hover:border-accent-primary hover:text-accent-primary transition-colors">
                                    <UserPlus className="w-5 h-5" />
                                </div>
                                <span className="text-[10px] text-text-tertiary mt-1">添加</span>
                            </button>
                        </div>
                    </div>

                    {/* Room Name */}
                    <div className="px-4 py-3 border-b border-border">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-text-secondary">🎯 群聊目标</span>
                            {isEditing ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        className="w-40 px-2 py-1 text-xs border border-border rounded bg-surface-secondary focus:ring-1 focus:ring-accent-primary focus:outline-none text-right"
                                        autoFocus
                                        placeholder="选题优化、标题优化..."
                                    />
                                    <button onClick={() => setIsEditing(false)} className="p-1 text-green-500">
                                        <Check className="w-3 h-3" />
                                    </button>
                                </div>
                            ) : (
                                <button onClick={() => setIsEditing(true)} className="flex items-center gap-1 text-xs text-text-primary hover:text-accent-primary">
                                    {name}
                                    <Pencil className="w-3 h-3 text-text-tertiary" />
                                </button>
                            )}
                        </div>
                        <p className="text-[10px] text-text-tertiary mt-1">群成员会围绕此目标进行讨论</p>
                    </div>

                    {/* Actions */}
                    <div className="px-4 py-3 space-y-2">
                        <button
                            onClick={handleSave}
                            disabled={!name.trim() || selectedIds.length === 0}
                            className="w-full py-2 text-sm text-white bg-accent-primary rounded-lg disabled:opacity-50 hover:bg-accent-primary/90"
                        >
                            保存更改
                        </button>
                    </div>

                    {/* Danger Zone */}
                    <div className="px-4 py-3 mt-auto border-t border-border">
                        <button
                            onClick={onDelete}
                            className="w-full py-2 text-sm text-red-500 hover:text-red-600"
                        >
                            解散群聊
                        </button>
                    </div>
                </div>
            </div>

            {/* Add Member Panel */}
            {showAddPanel && (
                <div className="fixed top-0 right-80 h-full w-64 bg-surface-secondary shadow-xl z-50 flex flex-col border-r border-border">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                        <h3 className="text-xs font-semibold text-text-primary">添加成员</h3>
                        <button onClick={() => setShowAddPanel(false)} className="p-1 text-text-tertiary hover:text-text-primary">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-auto p-3 space-y-2">
                        {availableToAdd.length === 0 ? (
                            <p className="text-xs text-text-tertiary text-center py-4">没有可添加的成员</p>
                        ) : (
                            availableToAdd.map((a) => (
                                <button
                                    key={a.id}
                                    onClick={() => addMember(a.id)}
                                    className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-surface-primary transition-colors"
                                >
                                    <span className={clsx(
                                        "w-8 h-8 rounded-lg flex items-center justify-center text-sm",
                                        AVATAR_COLORS[parseInt(a.id.slice(-1), 16) % AVATAR_COLORS.length]
                                    )}>
                                        {renderMemberAvatar(a.avatar || '🤖', undefined, a.id)}
                                    </span>
                                    <span className="text-xs text-text-primary">{a.name}</span>
                                    <UserPlus className="w-3 h-3 text-green-500 ml-auto" />
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
