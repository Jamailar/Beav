import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  ReactFlowProvider,
  useReactFlow,
  Panel,
  NodeProps,
  Handle,
  Position
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FileText, Folder, CheckCircle2, Archive, PenTool, Filter } from 'lucide-react';
import { clsx } from 'clsx';

// Types
interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    status?: 'writing' | 'completed' | 'abandoned';
}

interface GraphViewProps {
    files: FileNode[];
    onOpenFile: (path: string) => void;
    onCreateFile: (name: string, x: number, y: number) => void;
    onRenameFile: (oldPath: string, newName: string) => void;
}

// Flatten file tree into a list
const flattenFiles = (nodes: FileNode[], parentPath = ''): { name: string; path: string; isDirectory: boolean; status?: string }[] => {
    let result: { name: string; path: string; isDirectory: boolean; status?: string }[] = [];
    for (const node of nodes) {
        // node.path is already relative path from root
        if (!node.isDirectory) {
            result.push({ name: node.name, path: node.path, isDirectory: false, status: node.status });
        }
        if (node.children) {
            result = result.concat(flattenFiles(node.children, node.path));
        }
    }
    return result;
};

// Custom Node Component
const FileNodeComponent = ({ data, selected }: NodeProps) => {
    const isDir = data.isDirectory as boolean;
    const label = data.label as string;
    const isEditing = data.isEditing as boolean;
    const status = data.status as string; // 'writing' | 'completed' | 'abandoned'
    const onRename = data.onRename as (newName: string) => void;

    const [editValue, setEditValue] = useState(label);

    // Auto-focus input when entering edit mode
    const inputRef = useCallback((node: HTMLInputElement | null) => {
        if (node) {
            node.focus();
            node.select();
        }
    }, []);

    const handleSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (editValue.trim() && editValue !== label) {
            onRename(editValue);
        } else {
            // Cancel edit if empty or same
            onRename(label);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSubmit();
            e.stopPropagation(); // Prevent Flow from catching Enter
        } else if (e.key === 'Escape') {
            setEditValue(label);
            onRename(label); // Reset to original
            e.stopPropagation();
        }
    };

    // Determine styles based on status
    let statusBorder = "border-border";
    let statusIconColor = selected ? "text-accent-primary" : "text-blue-500";
    let StatusIcon = isDir ? Folder : FileText;

    if (!isDir) {
        if (status === 'completed') {
            statusBorder = "border-green-300 bg-green-50/50";
            statusIconColor = "text-green-500";
            StatusIcon = CheckCircle2;
        } else if (status === 'abandoned') {
            statusBorder = "border-red-200 bg-red-50/50 opacity-80";
            statusIconColor = "text-red-400";
            StatusIcon = Archive;
        } else {
            // writing / default
            StatusIcon = PenTool;
        }
    }

    return (
        <div
            className={clsx(
                "px-4 py-2 shadow-md rounded-md bg-surface-primary border min-w-[150px] flex items-center gap-2 transition-all cursor-pointer group",
                statusBorder,
                selected ? "border-accent-primary ring-1 ring-accent-primary" : "hover:border-accent-primary/50"
            )}
        >
            <Handle type="target" position={Position.Top} className="!bg-text-tertiary/20 !w-2 !h-2 opacity-0 group-hover:opacity-100 transition-opacity" />

            {isDir ? (
                <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
            ) : (
                <StatusIcon className={clsx("w-4 h-4 flex-shrink-0", statusIconColor)} />
            )}

            {isEditing ? (
                <input
                    ref={inputRef}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => handleSubmit()}
                    onKeyDown={handleKeyDown}
                    className="text-sm font-medium min-w-[200px] px-1 py-0.5 border border-accent-primary rounded bg-surface-secondary outline-none"
                    onClick={e => e.stopPropagation()}
                />
            ) : (
                <div className={clsx("text-sm font-medium whitespace-normal break-words max-w-[300px]", selected ? "text-accent-primary" : "text-text-primary")}>
                    {label}
                </div>
            )}

            <Handle type="source" position={Position.Bottom} className="!bg-text-tertiary/20 !w-2 !h-2 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
    );
};

// Internal component to use ReactFlow hooks
function GraphContent({ files, onOpenFile, onCreateFile, onRenameFile }: GraphViewProps) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();

    // Track which node is currently being edited
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

    // State for creating new file
    const [createModal, setCreateModal] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
    const [newFileName, setNewFileName] = useState("");

    // Filter states
    const [filters, setFilters] = useState({
        writing: true,
        completed: true,
        abandoned: true
    });

    // Load initial layout
    useEffect(() => {
        let isMounted = true;
        const loadLayout = async () => {
            try {
                const layout = (await window.ipcRenderer.invoke('manuscripts:get-layout') || {}) as Record<string, { x: number, y: number }>;

                if (!isMounted) return;

                const flatFiles = flattenFiles(files);

                // Apply filters
                const filteredFiles = flatFiles.filter(f => {
                    if (f.isDirectory) return true; // Always show folders (or maybe not?)
                    const status = f.status || 'writing';
                    if (status === 'writing' && !filters.writing) return false;
                    if (status === 'completed' && !filters.completed) return false;
                    if (status === 'abandoned' && !filters.abandoned) return false;
                    return true;
                });

                const newNodes: Node[] = filteredFiles.map((file, index) => {
                    // Default grid layout if no saved position
                    // Use simple grid to avoid overlap for new files
                    const cols = 5;
                    const spacingX = 220;
                    const spacingY = 100;

                    const pos = layout[file.path] || {
                        x: (index % cols) * spacingX + 50,
                        y: Math.floor(index / cols) * spacingY + 50
                    };

                    const isEditing = file.path === editingNodeId;

                    return {
                        id: file.path,
                        type: 'fileNode',
                        position: pos,
                        data: {
                            label: file.name.replace(/\.md$/, ''),
                            path: file.path,
                            isDirectory: file.isDirectory,
                            status: file.status || 'writing',
                            isEditing: isEditing,
                            onRename: (newName: string) => {
                                setEditingNodeId(null);
                                if (newName !== file.name.replace(/\.md$/, '')) {
                                    onRenameFile(file.path, newName);
                                }
                            }
                        },
                        draggable: !isEditing, // Disable dragging while editing
                    };
                });

                setNodes(newNodes);
            } catch (error) {
                console.error("Failed to load graph layout:", error);
            }
        };

        loadLayout();

        return () => { isMounted = false; };
    }, [files, setNodes, editingNodeId, onRenameFile, filters]);

    // Save layout on drag stop
    const onNodeDragStop = useCallback((event: any, node: Node) => {
        window.ipcRenderer.invoke('manuscripts:get-layout').then((currentLayout: any) => {
            const newLayout = {
                ...currentLayout,
                [node.id]: node.position
            };
            window.ipcRenderer.invoke('manuscripts:save-layout', newLayout);
        });
    }, []);

    const onNodeDoubleClick = useCallback((event: any, node: Node) => {
        onOpenFile(node.data.path as string);
    }, [onOpenFile]);

    // Handle Enter key to enter edit mode on selected node
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !createModal.visible && !editingNodeId) {
                // Find selected node
                const selectedNodes = nodes.filter(n => n.selected);
                if (selectedNodes.length === 1) {
                    e.preventDefault();
                    setEditingNodeId(selectedNodes[0].id);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [nodes, createModal.visible, editingNodeId]);

    const onPaneDoubleClick = useCallback((event: any) => {
        // Stop bubbling to avoid triggering on nodes if that happens
        // ReactFlow handles this, but good to be safe

        setCreateModal({ x: event.clientX, y: event.clientY, visible: true });
        setNewFileName("");
    }, []);

    // Store flow coordinates for creation separately to be precise
    const [creationPos, setCreationPos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        if (createModal.visible) {
             const position = screenToFlowPosition({
                x: createModal.x,
                y: createModal.y,
            });
            setCreationPos(position);
        }
    }, [createModal, screenToFlowPosition]);

    const handleCreateSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (newFileName.trim()) {
            onCreateFile(newFileName, creationPos.x, creationPos.y);
            setCreateModal({ ...createModal, visible: false });
        }
    };

    const nodeTypes = useMemo(() => ({ fileNode: FileNodeComponent }), []);

    return (
        <div className="w-full h-full bg-surface-secondary/10 relative">
             {/* Filter Controls */}
             <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-surface-primary/90 backdrop-blur border border-border rounded-full shadow-sm px-4 py-1.5 flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                    <Filter className="w-3.5 h-3.5" />
                    <span>筛选:</span>
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={filters.writing}
                        onChange={e => setFilters(prev => ({ ...prev, writing: e.target.checked }))}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-xs text-blue-600">写作中</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={filters.completed}
                        onChange={e => setFilters(prev => ({ ...prev, completed: e.target.checked }))}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    <span className="text-xs text-green-600">已完成</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={filters.abandoned}
                        onChange={e => setFilters(prev => ({ ...prev, abandoned: e.target.checked }))}
                        className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <span className="text-xs text-red-600">已废弃</span>
                </label>
            </div>

            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                onNodeDoubleClick={onNodeDoubleClick}
                onPaneClick={(event) => {
                    // Check if it's a double click manually if needed, or use onPaneClick
                    // ReactFlow 11 doesn't have onPaneDoubleClick in types by default or it was removed/renamed
                    // We can simulate it or just use onPaneClick + logic
                    if (event.detail === 2) {
                        onPaneDoubleClick(event as any);
                    }
                }}
                nodeTypes={nodeTypes}
                zoomOnDoubleClick={false}
                minZoom={0.1}
                maxZoom={2}
                fitView
            >
                <Background color="#ccc" gap={20} className="opacity-20" />
                <Controls showInteractive={false} />
                <MiniMap
                    zoomable
                    pannable
                    nodeColor={() => '#3b82f6'}
                    maskColor="rgba(240, 240, 240, 0.6)"
                    className="!bg-surface-primary border border-border rounded-lg shadow-sm"
                />

            </ReactFlow>

            {createModal.visible && (
                <div
                    className="fixed inset-0 z-50"
                    onClick={() => setCreateModal({ ...createModal, visible: false })}
                >
                    <div
                        className="absolute"
                        style={{
                            left: createModal.x,
                            top: createModal.y,
                            transform: 'translate(-50%, -50%)', // Center on click
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <form
                            onSubmit={handleCreateSubmit}
                            className="bg-surface-primary p-3 rounded-lg shadow-xl border border-border w-64 animate-in fade-in zoom-in duration-200"
                        >
                            <h3 className="text-xs font-semibold mb-2 text-text-secondary uppercase tracking-wider">New Manuscript</h3>
                            <input
                                autoFocus
                                type="text"
                                className="w-full px-2 py-1.5 border border-border rounded text-sm mb-3 outline-none focus:border-accent-primary focus:ring-1 focus:ring-accent-primary bg-surface-secondary/20 text-text-primary placeholder:text-text-tertiary"
                                placeholder="Enter title..."
                                value={newFileName}
                                onChange={e => setNewFileName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') setCreateModal({ ...createModal, visible: false });
                                    e.stopPropagation();
                                }}
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => setCreateModal({ ...createModal, visible: false })}
                                    className="px-2.5 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors rounded hover:bg-surface-secondary"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="px-2.5 py-1.5 text-xs bg-accent-primary text-white rounded hover:bg-accent-primary/90 shadow-sm font-medium transition-colors"
                                >
                                    Create
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export function GraphView(props: GraphViewProps) {
    return (
        <ReactFlowProvider>
            <GraphContent {...props} />
        </ReactFlowProvider>
    );
}
