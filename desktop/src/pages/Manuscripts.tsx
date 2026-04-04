import { useEffect, useState, useCallback, useRef } from 'react';
import {
    FolderPlus, FilePlus, ChevronRight,
    File, Folder, Trash2, Edit3, PanelLeft, Edit,
    PanelRight, MessageSquare, Users, BookOpen,
    GitGraph, CheckCircle2, Archive, PenTool, LayoutList, FolderTree, Copy, Sparkles, Link2, Send, Unplug, X, HelpCircle
} from 'lucide-react';
import { clsx } from 'clsx';
// Replaced MDEditor with CodeMirrorEditor
import { CodeMirrorEditor } from '../components/manuscripts/CodeMirrorEditor';
import { GraphView } from '../components/manuscripts/GraphView';
// import { Chat } from './Chat';
// import { CreativeChat } from './CreativeChat';
import { Knowledge } from './Knowledge';
import { PendingChatMessage } from '../App';
import { buildRedClawAuthoringMessage } from '../utils/redclawAuthoring';

// ========== Types ==========

interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    status?: 'writing' | 'completed' | 'abandoned';
}

interface ManuscriptsState {
    tree: FileNode[];
    selectedFile: string | null;
    expandedFolders: Set<string>;
    fileContent: string;
    fileMetadata: any;
    isModified: boolean;
    isLoading: boolean;
    isSaving: boolean;
}

interface WechatOfficialBindingSummary {
    id: string;
    name: string;
    appId: string;
    createdAt: string;
    updatedAt: string;
    verifiedAt?: string;
    isActive: boolean;
}

const SHOW_WECHAT_MANUSCRIPT_ACTIONS = false;
const WECHAT_DEV_PLATFORM_URL = 'https://developers.weixin.qq.com/';

const extractWechatWhitelistIp = (message: string): string => {
    const text = String(message || '').trim();
    if (!text) return '';
    const ipv4Match = text.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/);
    return ipv4Match?.[0] || '';
};

// ========== Component ==========

interface ManuscriptsProps {
    pendingFile?: string | null;
    onFileConsumed?: () => void;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    isActive?: boolean;
}

export function Manuscripts({ pendingFile, onFileConsumed, onNavigateToRedClaw, isActive = false }: ManuscriptsProps) {
    const [state, setState] = useState<ManuscriptsState>({
        tree: [],
        selectedFile: localStorage.getItem("manuscripts:lastOpenedFile"),
        expandedFolders: new Set(),
        fileContent: '',
        fileMetadata: {},
        isModified: false,
        isLoading: true,
        isSaving: false,
    });

    // 处理从其他页面传入的待打开文件
    useEffect(() => {
        if (pendingFile) {
            setState(prev => ({ ...prev, selectedFile: pendingFile }));
            onFileConsumed?.();
        }
    }, [pendingFile, onFileConsumed]);

    const [viewMode, setViewMode] = useState<'editor' | 'graph'>('editor');
    const [sidebarMode, setSidebarMode] = useState<'folders' | 'status'>('folders'); // New state for sidebar mode

    const [isSidebarOpen, setSidebarOpen] = useState(() => {
        const saved = localStorage.getItem("manuscripts:sidebarOpen");
        return saved ? JSON.parse(saved) : true;
    });

    useEffect(() => {
        localStorage.setItem("manuscripts:sidebarOpen", JSON.stringify(isSidebarOpen));
    }, [isSidebarOpen]);

    // Persist selected file
    useEffect(() => {
        if (state.selectedFile) {
            localStorage.setItem("manuscripts:lastOpenedFile", state.selectedFile);
        } else {
            localStorage.removeItem("manuscripts:lastOpenedFile");
        }
    }, [state.selectedFile]);

    // Restore file content on mount
    useEffect(() => {
        if (state.selectedFile && !state.fileContent) {
            window.ipcRenderer.invoke("manuscripts:read", state.selectedFile)
                .then((result: any) => {
                    const content = typeof result === 'string' ? result : result.content;
                    const metadata = typeof result === 'string' ? {} : result.metadata;

                    setState(prev => ({
                        ...prev,
                        fileContent: content || "",
                        fileMetadata: metadata || {},
                        isModified: false
                    }));
                })
                .catch(e => {
                    console.error("Failed to restore file:", e);
                    setState(prev => ({ ...prev, selectedFile: null }));
                });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
    }, [isSidebarOpen]);
    
    // Persistent State Initialization
    const [isRightPanelOpen, setRightPanelOpen] = useState(() => {
        const saved = localStorage.getItem('manuscripts:panelOpen');
        return saved ? JSON.parse(saved) : false;
    });
    
    const [rightPanelWidth, setRightPanelWidth] = useState(() => {
        const saved = localStorage.getItem('manuscripts:panelWidth');
        return saved ? parseInt(saved, 10) : 450;
    });

    const [isDragging, setIsDragging] = useState(false);

    // const [activeRightTab, setActiveRightTab] = useState<'chat' | 'creative' | 'knowledge'>(() => {
    //     const saved = localStorage.getItem('manuscripts:activeTab');
    //     return (saved as 'chat' | 'creative' | 'knowledge') || 'chat';
    // });

    const [pendingChatMsg, setPendingChatMsg] = useState<PendingChatMessage | null>(null);
    const [actionNotice, setActionNotice] = useState('');
    const [activeWechatBinding, setActiveWechatBinding] = useState<WechatOfficialBindingSummary | null>(null);
    const [wechatBindModalOpen, setWechatBindModalOpen] = useState(false);
    const [wechatHelpModalOpen, setWechatHelpModalOpen] = useState(false);
    const [wechatBindingBusy, setWechatBindingBusy] = useState(false);
    const [wechatPublishBusy, setWechatPublishBusy] = useState(false);
    const [wechatWhitelistIp, setWechatWhitelistIp] = useState('');
    const [wechatBindingDraft, setWechatBindingDraft] = useState({
        name: '',
        appId: '',
        secret: '',
    });

    const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
        const saved = localStorage.getItem('manuscripts:leftPanelWidth');
        return saved ? parseInt(saved, 10) : 200;
    });
    const [isLeftDragging, setIsLeftDragging] = useState(false);

    // File-Bound Chat Session State
    const [linkedSessionId, setLinkedSessionId] = useState<string | null>(null);

    const [titleValue, setTitleValue] = useState('');
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Persistence Effects
    useEffect(() => {
        localStorage.setItem('manuscripts:panelOpen', JSON.stringify(isRightPanelOpen));
    }, [isRightPanelOpen]);

    useEffect(() => {
        localStorage.setItem('manuscripts:panelWidth', rightPanelWidth.toString());
    }, [rightPanelWidth]);

    useEffect(() => {
        localStorage.setItem('manuscripts:leftPanelWidth', leftPanelWidth.toString());
    }, [leftPanelWidth]);

    useEffect(() => {
        if (!actionNotice) return;
        const timer = window.setTimeout(() => setActionNotice(''), 2600);
        return () => window.clearTimeout(timer);
    }, [actionNotice]);

    const loadWechatBindingStatus = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.wechatOfficial.getStatus();
            if (!result?.success) {
                throw new Error(result?.error || '加载公众号绑定状态失败');
            }
            setActiveWechatBinding(result.activeBinding || null);
        } catch (error) {
            console.error('Failed to load wechat official binding status:', error);
        }
    }, []);

    useEffect(() => {
        void loadWechatBindingStatus();
    }, [loadWechatBindingStatus]);

    // useEffect(() => {
    //     localStorage.setItem('manuscripts:activeTab', activeRightTab);
    // }, [activeRightTab]);

    // Resizing Logic
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isLeftDragging && containerRef.current) {
                // Calculate width relative to the container's left edge
                const containerRect = containerRef.current.getBoundingClientRect();
                const relativeX = e.clientX - containerRect.left;
                const newWidth = Math.max(150, Math.min(400, relativeX));
                setLeftPanelWidth(newWidth);
            } else if (isDragging) {
                const max = window.innerWidth * 0.8;
                const newWidth = Math.max(300, Math.min(max, window.innerWidth - e.clientX));
                setRightPanelWidth(newWidth);
            }
        };
        const handleMouseUp = () => {
            setIsDragging(false);
            setIsLeftDragging(false);
        };

        if (isDragging || isLeftDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [isDragging, isLeftDragging]);

    // Load file tree
    const loadTree = useCallback(async () => {
        try {
            const tree = await window.ipcRenderer.invoke('manuscripts:list') as FileNode[];
            setState(prev => ({ ...prev, tree: tree || [], isLoading: false }));
            return tree || [];
        } catch (e) {
            console.error('Failed to load manuscripts tree:', e);
            setState(prev => ({ ...prev, tree: [], isLoading: false }));
            return [];
        }
    }, []);

    useEffect(() => {
        loadTree();
    }, [loadTree]);

    const refreshSelectedFileFromDisk = useCallback(async () => {
        if (!state.selectedFile || state.isModified) return;

        try {
            const result = await window.ipcRenderer.invoke('manuscripts:read', state.selectedFile) as any;
            const content = typeof result === 'string' ? result : result.content;
            const metadata = typeof result === 'string' ? {} : result.metadata;

            setState(prev => {
                if (prev.selectedFile !== state.selectedFile || prev.isModified) {
                    return prev;
                }

                const nextContent = content || '';
                const nextMetadata = metadata || {};
                const sameContent = prev.fileContent === nextContent;
                const sameMetadata = JSON.stringify(prev.fileMetadata || {}) === JSON.stringify(nextMetadata);
                if (sameContent && sameMetadata) {
                    return prev;
                }

                return {
                    ...prev,
                    fileContent: nextContent,
                    fileMetadata: nextMetadata,
                    isModified: false,
                };
            });
        } catch (error) {
            console.error('Failed to refresh manuscript from disk:', error);
        }
    }, [state.selectedFile, state.isModified]);

    useEffect(() => {
        if (!isActive) return;

        const refresh = async () => {
            await loadTree();
            await refreshSelectedFileFromDisk();
        };

        refresh();
        const interval = window.setInterval(refresh, 3000);

        const onFocus = () => {
            refresh();
        };

        window.addEventListener('focus', onFocus);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('focus', onFocus);
        };
    }, [isActive, loadTree, refreshSelectedFileFromDisk]);

    // Sync title with selected file
    useEffect(() => {
        if (state.selectedFile) {
            const name = state.selectedFile.split('/').pop() || '';
            // Remove extension for display if it's .md
            const display = name.endsWith('.md') ? name.slice(0, -3) : name;
            setTitleValue(display);

            // Fetch/Create linked chat session
            // Wait for metadata to be loaded (which contains ID)
            if (state.fileMetadata && state.fileMetadata.id) {
                window.ipcRenderer.invoke('chat:getOrCreateFileSession', {
                    filePath: state.selectedFile,
                    fileId: state.fileMetadata.id
                })
                .then((session: any) => {
                    if (session && session.id) {
                        setLinkedSessionId(session.id);
                    }
                })
                .catch(err => console.error('Failed to get file session:', err));
            } else {
                 // Fallback if no ID yet (should satisfy rare race condition or legacy files)
                 window.ipcRenderer.invoke('chat:getOrCreateFileSession', { filePath: state.selectedFile })
                .then((session: any) => {
                    if (session && session.id) {
                        setLinkedSessionId(session.id);
                    }
                })
                .catch(err => console.error('Failed to get file session:', err));
            }

        } else {
            setTitleValue('');
            setLinkedSessionId(null);
        }
    }, [state.selectedFile, state.fileMetadata?.id]); // Add metadata.id dependency

    // Auto-save
    useEffect(() => {
        if (!state.selectedFile || !state.isModified) return;

        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

        saveTimeoutRef.current = setTimeout(async () => {
            setState(prev => ({ ...prev, isSaving: true }));
            try {
                await window.ipcRenderer.invoke('manuscripts:save', {
                    path: state.selectedFile,
                    content: state.fileContent,
                    metadata: state.fileMetadata
                });
                setState(prev => ({ ...prev, isModified: false, isSaving: false }));
            } catch (e) {
                console.error('Auto-save failed:', e);
                setState(prev => ({ ...prev, isSaving: false }));
            }
        }, 1000);

        return () => {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        };
    }, [state.fileContent, state.selectedFile, state.isModified]);

    // File Operations
    const handleSelectFile = async (filePath: string) => {
        if (state.selectedFile === filePath) return;

        // Save previous if modified
        if (state.selectedFile && state.isModified) {
            await window.ipcRenderer.invoke('manuscripts:save', {
                path: state.selectedFile,
                content: state.fileContent,
                metadata: state.fileMetadata
            });
        }

        try {
            const result = await window.ipcRenderer.invoke('manuscripts:read', filePath) as any;
            const content = typeof result === 'string' ? result : result.content;
            const metadata = typeof result === 'string' ? {} : result.metadata;

            setState(prev => ({
                ...prev,
                selectedFile: filePath,
                fileContent: content || '',
                fileMetadata: metadata || {},
                isModified: false
            }));
        } catch (e) {
            console.error('Failed to read file:', e);
        }
    };

    const toggleFolder = (path: string) => {
        setState(prev => {
            const newExpanded = new Set(prev.expandedFolders);
            if (newExpanded.has(path)) newExpanded.delete(path);
            else newExpanded.add(path);
            return { ...prev, expandedFolders: newExpanded };
        });
    };

    const handleCreate = async (type: 'file' | 'folder') => {
        const baseName = type === 'folder' ? "新建文件夹" : "未命名";
        let name = baseName;
        let counter = 1;

        // Check existence in root level
        const existingNames = new Set(state.tree.map(node => node.name));

        while (existingNames.has(type === 'file' ? `${name}.md` : name)) {
             name = `${baseName} (${counter})`;
             counter++;
        }

        try {
            if (type === 'folder') {
                await window.ipcRenderer.invoke('manuscripts:create-folder', { parentPath: '', name: name });
                await loadTree();
            } else {
                const fileName = `${name}.md`;
                const result = await window.ipcRenderer.invoke('manuscripts:create-file', { parentPath: '', name: fileName }) as { success: boolean, path?: string };
                await loadTree();

                if (result.success && result.path) {
                    handleSelectFile(result.path);
                }
            }
        } catch (e) {
            console.error('Create failed:', e);
        }
    };

    const handleDelete = async (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        if (!confirm('Delete this item?')) return;
        try {
            await window.ipcRenderer.invoke('manuscripts:delete', path);
            if (state.selectedFile === path) {
                setState(prev => ({ ...prev, selectedFile: localStorage.getItem("manuscripts:lastOpenedFile"), fileContent: '' }));
            }
            await loadTree();
        } catch (e) {
            console.error('Delete failed:', e);
        }
    };

    const handleTitleRename = async () => {
        if (!state.selectedFile || !titleValue.trim()) return;

        const currentName = state.selectedFile.split('/').pop() || '';
        const currentStem = currentName.endsWith('.md') ? currentName.slice(0, -3) : currentName;

        if (titleValue.trim() === currentStem) return; // No change

        const isMd = currentName.endsWith('.md');
        const newName = isMd ? `${titleValue.trim()}.md` : titleValue.trim();

        try {
            const result = await window.ipcRenderer.invoke('manuscripts:rename', {
                oldPath: state.selectedFile,
                newName: newName
            }) as { success: boolean, newPath?: string };

            if (result.success && result.newPath) {
                setState(prev => ({
                    ...prev,
                    selectedFile: result.newPath!
                }));
            }

            await loadTree();
        } catch (e) {
            console.error('Rename failed:', e);
            // Revert title on error
            setTitleValue(currentStem);
        }
    };

    // const handleNavigateToChat = (msg: any) => {
    //     setPendingChatMsg(msg);
    //     setActiveRightTab('chat');
    //     if (!isRightPanelOpen) {
    //         setRightPanelOpen(true);
    //     }
    // };

    const handleCreateFromGraph = async (name: string, x: number, y: number) => {
        const fileName = name.endsWith('.md') ? name : `${name}.md`;
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:create-file', { parentPath: '', name: fileName }) as { success: boolean, path?: string };

            if (result.success && result.path) {
                const currentLayout = (await window.ipcRenderer.invoke('manuscripts:get-layout') || {}) as Record<string, { x: number, y: number }>;
                await window.ipcRenderer.invoke('manuscripts:save-layout', {
                    ...currentLayout,
                    [result.path]: { x, y }
                });
                await loadTree();
            }
        } catch (e) {
            console.error('Failed to create file from graph:', e);
        }
    };

    const saveCurrentFileNow = useCallback(async () => {
        if (!state.selectedFile) return true;
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:save', {
                path: state.selectedFile,
                content: state.fileContent,
                metadata: state.fileMetadata,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '保存失败');
            }
            setState((prev) => ({ ...prev, isModified: false }));
            return true;
        } catch (error) {
            console.error('Failed to save manuscript before action:', error);
            setActionNotice(error instanceof Error ? error.message : '保存失败');
            return false;
        }
    }, [state.fileContent, state.fileMetadata, state.selectedFile]);

    const handleGenerateWechatVersion = useCallback(async () => {
        if (!state.selectedFile || !onNavigateToRedClaw) return;
        const saved = await saveCurrentFileNow();
        if (!saved) return;

        const currentPlatform = String(state.fileMetadata?.platform || '').trim() === 'wechat_official_account'
            ? 'wechat_official_account'
            : 'xiaohongshu';
        const taskType = currentPlatform === 'xiaohongshu' ? 'expand_from_xhs' : 'direct_write';

        onNavigateToRedClaw(buildRedClawAuthoringMessage({
            platform: 'wechat_official_account',
            taskType,
            brief: currentPlatform === 'xiaohongshu'
                ? '请把当前稿件扩写为公众号文章，并补足摘要、导语、论证、案例、结尾 CTA 与配图建议。'
                : '请基于当前稿件继续完善公众号文章结构，并生成可保存的公众号稿件包。',
            sourceMode: 'manuscript',
            sourcePlatform: currentPlatform,
            sourceTitle: String(state.fileMetadata?.title || titleValue || '').trim() || undefined,
            sourceManuscriptPath: state.selectedFile,
            sourceContent: state.fileContent,
        }));
    }, [onNavigateToRedClaw, saveCurrentFileNow, state.fileContent, state.fileMetadata, state.selectedFile, titleValue]);

    const handleCopyWechatRichText = useCallback(async () => {
        if (!state.selectedFile) return;
        const saved = await saveCurrentFileNow();
        if (!saved) return;

        const formatResult = await window.ipcRenderer.invoke('manuscripts:format-wechat', {
            title: String(state.fileMetadata?.title || titleValue || '').trim(),
            content: state.fileContent,
            metadata: state.fileMetadata,
        }) as { success?: boolean; html?: string; plainText?: string; error?: string };

        if (!formatResult?.success || !formatResult.html) {
            setActionNotice(formatResult?.error || '公众号排版失败');
            return;
        }

        const copyResult = await window.ipcRenderer.invoke('clipboard:write-html', {
            html: formatResult.html,
            text: formatResult.plainText || state.fileContent,
        }) as { success?: boolean; error?: string };

        setActionNotice(copyResult?.success ? '公众号富文本已复制' : (copyResult?.error || '复制失败'));
    }, [saveCurrentFileNow, state.fileContent, state.fileMetadata, state.selectedFile, titleValue]);

    const handleBindWechatOfficial = useCallback(async () => {
        const appId = wechatBindingDraft.appId.trim();
        const secret = wechatBindingDraft.secret.trim();
        if (!appId || !secret) {
            setActionNotice('请先填写 AppID 和 Secret');
            window.alert('请先填写 AppID 和 Secret');
            return;
        }
        setWechatBindingBusy(true);
        try {
            const result = await window.ipcRenderer.wechatOfficial.bind({
                name: wechatBindingDraft.name.trim() || undefined,
                appId,
                secret,
                setActive: true,
            });
            if (!result?.success || !result.binding) {
                throw new Error(result?.error || '绑定失败');
            }
            await loadWechatBindingStatus();
            setWechatBindingDraft((prev) => ({ ...prev, secret: '' }));
            setWechatBindModalOpen(false);
            setActionNotice(`已绑定公众号：${result.binding.name}`);
            window.alert(`绑定成功：${result.binding.name}`);
        } catch (error) {
            console.error('Failed to bind wechat official account:', error);
            const message = error instanceof Error ? error.message : '绑定失败';
            const whitelistIp = extractWechatWhitelistIp(message);
            setActionNotice(message);
            setWechatWhitelistIp(whitelistIp);
            if (whitelistIp) {
                setWechatHelpModalOpen(true);
            }
            window.alert(`绑定失败：${message}`);
        } finally {
            setWechatBindingBusy(false);
        }
    }, [loadWechatBindingStatus, wechatBindingDraft]);

    const openWechatDeveloperPlatform = useCallback(async () => {
        try {
            await window.ipcRenderer.openAppReleasePage(WECHAT_DEV_PLATFORM_URL);
        } catch (error) {
            console.error('Failed to open WeChat developer platform:', error);
        }
    }, []);

    const handleUnbindWechatOfficial = useCallback(async () => {
        if (!activeWechatBinding) return;
        if (!window.confirm(`解绑公众号“${activeWechatBinding.name}”？`)) return;
        setWechatBindingBusy(true);
        try {
            const result = await window.ipcRenderer.wechatOfficial.unbind({
                bindingId: activeWechatBinding.id,
            });
            if (!result?.success) {
                throw new Error(result?.error || '解绑失败');
            }
            await loadWechatBindingStatus();
            setActionNotice('公众号已解绑');
        } catch (error) {
            console.error('Failed to unbind wechat official account:', error);
            setActionNotice(error instanceof Error ? error.message : '解绑失败');
        } finally {
            setWechatBindingBusy(false);
        }
    }, [activeWechatBinding, loadWechatBindingStatus]);

    const handleCreateWechatDraft = useCallback(async () => {
        if (!state.selectedFile) return;
        if (!activeWechatBinding) {
            setWechatBindModalOpen(true);
            setActionNotice('请先绑定公众号');
            return;
        }

        const saved = await saveCurrentFileNow();
        if (!saved) return;

        setWechatPublishBusy(true);
        try {
            const result = await window.ipcRenderer.wechatOfficial.createDraft({
                bindingId: activeWechatBinding.id,
                title: String(state.fileMetadata?.title || titleValue || '').trim() || undefined,
                content: state.fileContent,
                metadata: state.fileMetadata,
                sourcePath: state.selectedFile,
            });
            if (!result?.success) {
                throw new Error(result?.error || '推送草稿失败');
            }
            setActionNotice(result.mediaId ? `公众号草稿已创建：${result.mediaId}` : '公众号草稿已创建');
        } catch (error) {
            console.error('Failed to create wechat official draft:', error);
            setActionNotice(error instanceof Error ? error.message : '推送草稿失败');
        } finally {
            setWechatPublishBusy(false);
        }
    }, [activeWechatBinding, saveCurrentFileNow, state.fileContent, state.fileMetadata, state.selectedFile, titleValue]);

    const handleRenameNode = async (oldPath: string, newName: string) => {
        const currentName = oldPath.split('/').pop() || '';
        const isMd = currentName.endsWith('.md');
        const finalName = (isMd && !newName.endsWith('.md')) ? `${newName}.md` : newName;

        try {
            const result = await window.ipcRenderer.invoke('manuscripts:rename', {
                oldPath,
                newName: finalName
            }) as { success: boolean, newPath?: string };

            if (result.success) {
                await loadTree();
                // Update selected file if it was renamed
                if (state.selectedFile === oldPath && result.newPath) {
                    setState(prev => ({ ...prev, selectedFile: result.newPath! }));
                }

                // Also update layout if needed?
                // The layout keys are paths. If path changes, we might lose position if we don't migrate it.
                // However, manuscripts:rename implementation in backend doesn't seem to update layout.json automatically.
                // We should probably handle layout migration here.

                const currentLayout = (await window.ipcRenderer.invoke('manuscripts:get-layout') || {}) as Record<string, { x: number, y: number }>;
                if (currentLayout[oldPath]) {
                    // Explicitly cast to object to allow destructuring with spread
                    const layoutObj = currentLayout as Record<string, any>;
                    const { [oldPath]: pos, ...rest } = layoutObj;
                    if (result.newPath) {
                        await window.ipcRenderer.invoke('manuscripts:save-layout', {
                            ...rest,
                            [result.newPath]: pos
                        });
                    }
                }
            }
        } catch (e) {
            console.error('Rename failed:', e);
        }
    };

    // Render Helpers
    const renderNode = (node: FileNode, depth: number = 0) => {
        const isExpanded = state.expandedFolders.has(node.path);
        const isSelected = state.selectedFile === node.path;
        const displayName = node.name.endsWith('.md') ? node.name.slice(0, -3) : node.name;

        // Status indicator color
        let statusColor = "text-text-tertiary";
        if (node.status === 'completed') statusColor = "text-status-success";
        if (node.status === 'abandoned') statusColor = "text-status-error";
        if (node.status === 'writing') statusColor = "text-accent-primary";

        return (
            <div key={node.path}>
                <div
                    className={clsx(
                        "flex items-center px-3 py-1.5 text-sm cursor-pointer rounded-md transition-colors group",
                        isSelected ? "bg-accent-primary/10 text-accent-primary font-medium" : "text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                    )}
                    style={{ paddingLeft: `${depth * 12 + 12}px` }}
                    onClick={() => node.isDirectory ? toggleFolder(node.path) : handleSelectFile(node.path)}
                >
                    {node.isDirectory ? (
                        <>
                            <span className={clsx("mr-1.5 transition-transform", isExpanded && "rotate-90")}>
                                <ChevronRight className="w-3.5 h-3.5 opacity-50" />
                            </span>
                            <Folder className={clsx("w-4 h-4 mr-2", isExpanded ? "text-text-primary" : "text-text-tertiary")} />
                        </>
                    ) : (
                        <>
                            <span className="w-5" />
                            <File className={clsx("w-3.5 h-3.5 mr-2 opacity-50", statusColor)} />
                        </>
                    )}

                    <span className="flex-1 truncate">{displayName}</span>

                    <button
                        onClick={(e) => handleDelete(e, node.path)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-status-error/10 hover:text-status-error rounded"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>

                {node.isDirectory && isExpanded && node.children && (
                    <div>{node.children.map(child => renderNode(child, depth + 1))}</div>
                )}
            </div>
        );
    };

    const getAllFiles = (nodes: FileNode[]): FileNode[] => {
        let files: FileNode[] = [];
        for (const node of nodes) {
            if (node.isDirectory && node.children) {
                files = [...files, ...getAllFiles(node.children)];
            } else if (!node.isDirectory) {
                files.push(node);
            }
        }
        return files;
    };

    const renderStatusGroup = (title: string, status: string, icon: React.ReactNode, files: FileNode[]) => {
        const isExpanded = state.expandedFolders.has(`status:${status}`);

        return (
            <div key={status} className="mb-2">
                <div
                    className="flex items-center px-3 py-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider cursor-pointer hover:text-text-primary"
                    onClick={() => toggleFolder(`status:${status}`)}
                >
                    <span className={clsx("mr-1.5 transition-transform", isExpanded && "rotate-90")}>
                        <ChevronRight className="w-3.5 h-3.5" />
                    </span>
                    <span className="mr-2">{icon}</span>
                    {title} <span className="ml-1 opacity-50">({files.length})</span>
                </div>

                {isExpanded && (
                    <div className="mt-1">
                        {files.map(node => renderNode({ ...node, isDirectory: false }, 0))}
                    </div>
                )}
            </div>
        );
    };

    const renderSidebarContent = () => {
        if (sidebarMode === 'folders') {
            return state.tree.map(node => renderNode(node));
        }

        const allFiles = getAllFiles(state.tree);
        const writing = allFiles.filter(f => !f.status || f.status === 'writing');
        const completed = allFiles.filter(f => f.status === 'completed');
        const abandoned = allFiles.filter(f => f.status === 'abandoned');

        return (
            <div className="py-2">
                {renderStatusGroup('Writing', 'writing', <PenTool className="w-3 h-3" />, writing)}
                {renderStatusGroup('Completed', 'completed', <CheckCircle2 className="w-3 h-3" />, completed)}
                {renderStatusGroup('Abandoned', 'abandoned', <Archive className="w-3 h-3" />, abandoned)}
            </div>
        );
    };

    return (
        <div ref={containerRef} className="flex h-full min-h-0 bg-background overflow-hidden">
            {/* Sidebar */}
            <div
                className={clsx(
                    "flex flex-col border-r border-border bg-surface-secondary/10 overflow-hidden h-full",
                    isSidebarOpen ? "opacity-100" : "w-0 opacity-0 border-r-0"
                )}
                style={{ width: isSidebarOpen ? leftPanelWidth : 0, transition: isLeftDragging ? 'none' : 'width 300ms, opacity 300ms' }}
            >
                <div className="flex flex-col h-full" style={{ width: leftPanelWidth }}>
                    <div className="p-3 border-b border-border flex items-center justify-between">
                        <div className="flex gap-1">
                             <button
                                onClick={() => setSidebarMode(m => m === 'folders' ? 'status' : 'folders')}
                                className={clsx(
                                    "p-1 hover:bg-surface-secondary rounded transition-colors",
                                    sidebarMode === 'status' ? "text-accent-primary bg-accent-primary/10" : "text-text-tertiary"
                                )}
                                title={sidebarMode === 'folders' ? "View by Status" : "View by Folder"}
                            >
                                {sidebarMode === 'folders' ? <FolderTree className="w-4 h-4" /> : <LayoutList className="w-4 h-4" />}
                            </button>
                        </div>
                        <div className="flex gap-1 ml-auto">
                            <button
                                onClick={() => setViewMode(prev => prev === 'editor' ? 'graph' : 'editor')}
                                className={clsx(
                                    "p-1 hover:bg-surface-secondary rounded transition-colors mr-2",
                                    viewMode === 'graph' ? "bg-accent-primary/10 text-accent-primary" : "text-text-tertiary"
                                )}
                                title={viewMode === 'editor' ? "Switch to Graph View" : "Switch to List View"}
                            >
                                <GitGraph className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleCreate('file')} className="p-1 hover:bg-surface-secondary rounded" title="New File">
                                <FilePlus className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleCreate('folder')} className="p-1 hover:bg-surface-secondary rounded" title="New Folder">
                                <FolderPlus className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto p-2">
                        {renderSidebarContent()}
                    </div>
                </div>
            </div>

            {/* Left Resize Handle */}
            {isSidebarOpen && (
                <div
                    className={clsx(
                        "w-1 cursor-col-resize z-50 transition-colors flex flex-col justify-center items-center hover:bg-accent-primary/50",
                        isLeftDragging ? "bg-accent-primary" : "bg-transparent"
                    )}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        setIsLeftDragging(true);
                    }}
                >
                </div>
            )}

            {/* Editor Area */}
            <div className="flex-1 min-h-0 flex flex-col h-full overflow-hidden bg-surface-primary relative">
                {/* Top Toolbar for Panels and Navigation */}
                <div className="h-10 px-3 flex items-center justify-between border-b border-border/10 bg-surface-secondary/5 z-20">
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setSidebarOpen(!isSidebarOpen)}
                            className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-md transition-colors"
                            title={isSidebarOpen ? "Close Sidebar" : "Open Sidebar"}
                        >
                            <PanelLeft className="w-5 h-5" />
                        </button>
                        {!isSidebarOpen && (
                            <button
                                onClick={() => handleCreate('file')}
                                className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-md transition-colors"
                                title="New Manuscript"
                            >
                                <Edit className="w-5 h-5" />
                            </button>
                        )}
                        {/* Selected file path breadcrumb or info (optional) */}
                        {state.selectedFile && !isSidebarOpen && (
                             <span className="text-[10px] text-text-tertiary ml-2 uppercase tracking-widest font-medium opacity-50">
                                {state.selectedFile.split('/').slice(-2).join(' / ')}
                             </span>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {state.selectedFile && SHOW_WECHAT_MANUSCRIPT_ACTIONS && (
                            <>
                                <button
                                    onClick={() => setWechatBindModalOpen(true)}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100"
                                    title={activeWechatBinding ? `当前已绑定：${activeWechatBinding.name}` : '绑定公众号'}
                                >
                                    <Link2 className="w-3.5 h-3.5" />
                                    {activeWechatBinding ? activeWechatBinding.name : '绑定公众号'}
                                </button>
                                {onNavigateToRedClaw && (
                                    <button
                                        onClick={() => void handleGenerateWechatVersion()}
                                        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
                                        title="基于当前稿件生成公众号版本"
                                    >
                                        <Sparkles className="w-3.5 h-3.5" />
                                        生成公众号版
                                    </button>
                                )}
                                <button
                                    onClick={() => void handleCopyWechatRichText()}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
                                    title="将当前稿件排版为公众号富文本并复制"
                                >
                                    <Copy className="w-3.5 h-3.5" />
                                    公众号排版复制
                                </button>
                                <button
                                    onClick={() => void handleCreateWechatDraft()}
                                    disabled={wechatPublishBusy}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                                        wechatPublishBusy
                                            ? 'cursor-not-allowed border-amber-200 bg-amber-50 text-amber-600 opacity-70'
                                            : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
                                    )}
                                    title="将当前稿件直接推送到公众号草稿箱"
                                >
                                    <Send className="w-3.5 h-3.5" />
                                    {wechatPublishBusy ? '推送中...' : '推送公众号草稿'}
                                </button>
                            </>
                        )}
                        {actionNotice && (
                            <span className="text-xs text-text-tertiary">{actionNotice}</span>
                        )}
                         {/* Right Panel Toggle */}
                        {!isRightPanelOpen && (
                            <button
                                onClick={() => setRightPanelOpen(true)}
                                className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-md transition-colors"
                                title="Open Tools Panel"
                            >
                                <PanelRight className="w-5 h-5" />
                            </button>
                        )}
                    </div>
                </div>

                {viewMode === 'graph' ? (
                    <div className="flex-1 min-h-0 overflow-hidden relative">
                        <GraphView
                            files={state.tree}
                            onOpenFile={(path) => {
                                handleSelectFile(path);
                                setViewMode('editor');
                            }}
                            onCreateFile={handleCreateFromGraph}
                            onRenameFile={handleRenameNode}
                        />
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-surface-primary">
                        {state.selectedFile ? (
                            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                                {/* Centered Container for Title and Editor */}
                                <div className="flex-1 flex flex-col min-h-0 custom-scrollbar overflow-y-auto">
                                    {/* Document Header (Title Area) */}
                                    <div className="w-full max-w-[900px] mx-auto pt-0 px-10 pb-1">
                                        <div className="flex flex-col gap-1 group/title">
                                            {/* Status Selector - Moved to top for better focus on title */}
                                            <div className="flex items-center gap-2 opacity-30 group-hover/title:opacity-100 transition-opacity">
                                                <select
                                                    value={state.fileMetadata.status || 'writing'}
                                                    onChange={(e) => {
                                                        const newStatus = e.target.value;
                                                        // Internal state update for immediate feedback
                                                        const updateTreeStatus = (nodes: FileNode[]): FileNode[] => {
                                                            return nodes.map(node => {
                                                                if (node.path === state.selectedFile) {
                                                                    return { ...node, status: newStatus as any };
                                                                }
                                                                if (node.children) {
                                                                    return { ...node, children: updateTreeStatus(node.children) };
                                                                }
                                                                return node;
                                                            });
                                                        };

                                                        setState(prev => ({
                                                            ...prev,
                                                            tree: updateTreeStatus(prev.tree),
                                                            fileMetadata: { ...prev.fileMetadata, status: newStatus },
                                                            isModified: true
                                                        }));
                                                    }}
                                                    className={clsx(
                                                        "text-[9px] font-bold px-1.5 py-0.5 rounded border outline-none cursor-pointer appearance-none text-center min-w-[60px] uppercase tracking-wider transition-all",
                                                        (!state.fileMetadata.status || state.fileMetadata.status === 'writing') && "bg-accent-primary/5 text-accent-primary border-accent-primary/10 hover:bg-accent-primary/10",
                                                        state.fileMetadata.status === 'completed' && "bg-status-success/5 text-status-success border-status-success/10 hover:bg-status-success/10",
                                                        state.fileMetadata.status === 'abandoned' && "bg-status-error/5 text-status-error border-status-error/10 hover:bg-status-error/10"
                                                    )}
                                                >
                                                    <option value="writing">写作</option>
                                                    <option value="completed">完成</option>
                                                    <option value="abandoned">废弃</option>
                                                </select>
                                                <div className="h-[1px] flex-1 bg-border/20" />
                                            </div>

                                            <textarea
                                                ref={(el) => {
                                                    if (el) {
                                                        el.style.height = 'auto';
                                                        el.style.height = el.scrollHeight + 'px';
                                                    }
                                                }}
                                                value={titleValue}
                                                onChange={e => {
                                                    setTitleValue(e.target.value);
                                                    e.target.style.height = 'auto';
                                                    e.target.style.height = e.target.scrollHeight + 'px';
                                                }}
                                                onBlur={handleTitleRename}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        e.currentTarget.blur();
                                                    }
                                                }}
                                                className="text-4xl font-bold text-text-primary bg-transparent outline-none w-full placeholder-text-tertiary/20 border-none p-0 focus:ring-0 resize-none overflow-hidden min-h-[1.2em] block leading-tight"
                                                placeholder="Untitled"
                                                rows={1}
                                            />
                                        </div>
                                        {/* Minimal spacing before editor */}
                                        <div className="h-1" />
                                    </div>

                                    {/* Editor Area */}
                                    <div className="flex-1">
                                        <CodeMirrorEditor
                                            value={state.fileContent}
                                            onChange={(val) => setState(prev => ({ ...prev, fileContent: val, isModified: true }))}
                                        />
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary">
                                <Edit3 className="w-12 h-12 mb-4 opacity-20" />
                                <p>选择文件开始编辑</p>
                            </div>
                        )}
                    </div>
                )}


                {/* Saving Indicator */}
                {state.isSaving && (
                    <div className="absolute bottom-4 right-8 text-xs text-text-tertiary bg-surface-secondary/50 px-2 py-1 rounded">
                        保存中...
                    </div>
                )}
            </div>

            {/* Resize Handle */}
            {isRightPanelOpen && (
                <div
                    className={clsx(
                        "w-1 cursor-col-resize z-50 transition-colors flex flex-col justify-center items-center hover:bg-accent-primary/50",
                        isDragging ? "bg-accent-primary" : "bg-border"
                    )}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        setIsDragging(true);
                    }}
                >
                    {/* Visual Grip Indicator (optional) */}
                    <div className="h-8 w-0.5 bg-text-tertiary/20 rounded-full" />
                </div>
            )}

            {/* Right Panel (Split View) */}
            <div
                className={clsx(
                    "flex flex-col min-h-0 bg-surface-primary overflow-hidden h-full shadow-xl",
                    // Use transition for opacity but not width (to keep dragging smooth)
                    isRightPanelOpen ? "opacity-100" : "opacity-0 w-0"
                )}
                style={{ width: isRightPanelOpen ? rightPanelWidth : 0 }}
            >
                {/* Right Panel Header - Minimal */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-surface-secondary/30">
                    <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5" />
                        知识库
                    </span>
                    <button
                        onClick={() => setRightPanelOpen(false)}
                        className="p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors"
                        title="Close Panel"
                    >
                        <PanelRight className="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* Right Panel Content */}
                <div className="flex-1 min-h-0 overflow-hidden relative">
                    <div className="h-full w-full">
                        <Knowledge
                            isEmbedded={true}
                            referenceContent={state.fileContent}
                            onNavigateToRedClaw={onNavigateToRedClaw}
                        />
                    </div>
                </div>
            </div>

            {wechatBindModalOpen && (
                <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-4">
                    <div className="w-full max-w-lg rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-5 py-4">
                            <div className="flex items-center gap-2">
                                <div className="text-sm font-semibold text-text-primary">绑定公众号</div>
                                <button
                                    onClick={() => setWechatHelpModalOpen(true)}
                                    className="rounded-full p-1 text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                    title="查看 AppID / Secret 获取方式"
                                >
                                    <HelpCircle className="h-4 w-4" />
                                </button>
                            </div>
                            <button
                                onClick={() => setWechatBindModalOpen(false)}
                                className="rounded-md p-1 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="space-y-4 px-5 py-5">
                            <div className="grid gap-3">
                                <label className="grid gap-1">
                                    <span className="text-xs font-medium text-text-secondary">显示名称</span>
                                    <input
                                        value={wechatBindingDraft.name}
                                        onChange={(e) => setWechatBindingDraft((prev) => ({ ...prev, name: e.target.value }))}
                                        className="rounded-xl border border-border bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                                        placeholder="例如：增长实验室公众号"
                                    />
                                </label>
                                <label className="grid gap-1">
                                    <span className="text-xs font-medium text-text-secondary">AppID</span>
                                    <input
                                        value={wechatBindingDraft.appId}
                                        onChange={(e) => setWechatBindingDraft((prev) => ({ ...prev, appId: e.target.value }))}
                                        className="rounded-xl border border-border bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                                        placeholder="wx..."
                                    />
                                </label>
                                <label className="grid gap-1">
                                    <span className="text-xs font-medium text-text-secondary">Secret</span>
                                    <input
                                        type="password"
                                        value={wechatBindingDraft.secret}
                                        onChange={(e) => setWechatBindingDraft((prev) => ({ ...prev, secret: e.target.value }))}
                                        className="rounded-xl border border-border bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                                        placeholder="公众号开发者 Secret"
                                    />
                                </label>
                            </div>
                        </div>
                        <div className="flex items-center justify-between border-t border-border px-5 py-4">
                            <div className="flex items-center gap-2">
                                {activeWechatBinding && (
                                    <button
                                        onClick={() => void handleUnbindWechatOfficial()}
                                        disabled={wechatBindingBusy}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        <Unplug className="h-3.5 w-3.5" />
                                        解绑
                                    </button>
                                )}
                                <button
                                    onClick={() => void handleBindWechatOfficial()}
                                    disabled={wechatBindingBusy}
                                    className="rounded-lg bg-accent-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {wechatBindingBusy ? '验证中...' : '验证并绑定'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {wechatHelpModalOpen && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4">
                    <div className="w-full max-w-2xl rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-6 py-4">
                            <div className="text-base font-semibold text-text-primary">公众号绑定说明</div>
                            <button
                                onClick={() => setWechatHelpModalOpen(false)}
                                className="rounded-md p-1 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="space-y-5 px-6 py-5 text-sm text-text-secondary">
                            <div className="rounded-xl border border-border bg-surface-secondary/40 p-4">
                                <div className="font-medium text-text-primary">1. 获取 AppID 和 Secret</div>
                                <div className="mt-2 leading-7">
                                    进入微信开发平台或公众号后台的开发接口管理页面，开启开发配置后即可看到公众号的 <span className="font-medium text-text-primary">AppID</span>，并生成或重置 <span className="font-medium text-text-primary">Secret</span>。
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                    <button
                                        onClick={() => void openWechatDeveloperPlatform()}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100"
                                    >
                                        <Link2 className="h-3.5 w-3.5" />
                                        打开微信开发平台
                                    </button>
                                    <span className="text-xs text-text-tertiary">{WECHAT_DEV_PLATFORM_URL}</span>
                                </div>
                            </div>

                            <div className="rounded-xl border border-border bg-surface-secondary/40 p-4">
                                <div className="font-medium text-text-primary">2. 如果提示 IP 不在白名单</div>
                                <div className="mt-2 leading-7">
                                    说明公众号后台限制了调用来源。你需要把当前网络出口 IP 加到公众号开发配置的 <span className="font-medium text-text-primary">IP 白名单</span> 中，然后再回来重新绑定。
                                </div>
                                <div className="mt-3 rounded-lg bg-surface-primary px-3 py-3">
                                    <div className="text-xs text-text-tertiary">当前需要加白名单的 IP</div>
                                    <div className="mt-1 text-base font-semibold text-text-primary">
                                        {wechatWhitelistIp || '绑定失败后会在这里显示当前出口 IP'}
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end border-t border-border px-6 py-4">
                            <button
                                onClick={() => setWechatHelpModalOpen(false)}
                                className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
                            >
                                我知道了
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
