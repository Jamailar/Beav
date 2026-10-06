import React from 'react';
import {
    Bold, Italic, Heading1, Quote, List, ListOrdered,
    Check, Cloud, CloudOff
} from 'lucide-react';
import { ICommand, commands } from '@uiw/react-md-editor';

interface ManuscriptToolbarProps {
    isModified: boolean;
    isSaving: boolean;
    onCommand: (command: ICommand) => void;
}

export function ManuscriptToolbar({
    isModified,
    isSaving,
    onCommand
}: ManuscriptToolbarProps) {

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-2 py-1.5 bg-surface-primary/90 backdrop-blur-sm border border-border/50 rounded-full shadow-lg z-20 transition-all duration-300 hover:shadow-xl">
            {/* Formatting Tools */}
            <button onClick={() => onCommand(commands.bold)} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Bold">
                <Bold className="w-4 h-4" />
            </button>
            <button onClick={() => onCommand(commands.italic)} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Italic">
                <Italic className="w-4 h-4" />
            </button>
            <button onClick={() => onCommand(commands.group([commands.title1, commands.title2, commands.title3, commands.title4, commands.title5, commands.title6], { name: 'title', groupName: 'title', buttonProps: { 'aria-label': 'Insert title'} }))} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Heading">
                <Heading1 className="w-4 h-4" />
            </button>
            <button onClick={() => onCommand(commands.quote)} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Quote">
                <Quote className="w-4 h-4" />
            </button>
            <button onClick={() => onCommand(commands.unorderedListCommand)} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Bullet List">
                <List className="w-4 h-4" />
            </button>
            <button onClick={() => onCommand(commands.orderedListCommand)} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors" title="Numbered List">
                <ListOrdered className="w-4 h-4" />
            </button>

            {/* Divider */}
            <div className="w-px h-4 bg-border" />

            {/* Status */}
            <div className="px-2 flex items-center gap-1.5 text-xs font-medium text-text-tertiary min-w-[60px] justify-center">
                {isSaving ? (
                    <>
                        <Cloud className="w-3.5 h-3.5 animate-pulse" />
                        <span>Saving...</span>
                    </>
                ) : isModified ? (
                    <>
                        <CloudOff className="w-3.5 h-3.5 text-yellow-500" />
                        <span className="text-yellow-500">Unsaved</span>
                    </>
                ) : (
                    <>
                        <Check className="w-3.5 h-3.5 text-green-500" />
                        <span className="text-green-500">Saved</span>
                    </>
                )}
            </div>
        </div>
    );
}
