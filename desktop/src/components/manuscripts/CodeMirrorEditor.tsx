import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { tags } from '@lezer/highlight';

interface CodeMirrorEditorProps {
    value: string;
    onChange: (value: string) => void;
    className?: string;
    diffOriginalValue?: string | null;
}

// Custom theme for "Obsidian-like" feel
const obsidianTheme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "16px",
        color: "rgb(var(--color-text-primary) / 1)",
        backgroundColor: "rgb(var(--color-surface-primary) / 1)",
    },
    ".cm-editor": {
        height: "100%",
        minHeight: "100%",
        color: "rgb(var(--color-text-primary) / 1)",
        backgroundColor: "rgb(var(--color-surface-primary) / 1)",
    },
    ".cm-scroller": {
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
        lineHeight: "1.6",
        height: "100%",
        minHeight: "100%",
        overflowX: "hidden",
        overflowY: "auto",
        color: "rgb(var(--color-text-primary) / 1)",
    },
    ".cm-sizer": {
        minHeight: "100%",
    },
    ".cm-content": {
        boxSizing: "border-box",
        padding: "32px 40px 120px 40px",
        minHeight: "100%",
        color: "rgb(var(--color-text-primary) / 1)",
    },
    ".cm-placeholder": {
        color: "rgb(var(--color-text-tertiary) / 1)",
    },
    ".cm-line": {
        padding: "0 4px",
    },
    ".cm-activeLine": {
        backgroundColor: "rgb(var(--color-surface-secondary) / 0.55)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "rgb(var(--color-accent-primary) / 0.24)",
    },
    ".cm-cursor": {
        borderLeftColor: "var(--color-accent-primary, #007AFF)",
        borderLeftWidth: "2px",
    },
    "&.cm-focused": {
        outline: "none",
    },
    // Hide gutters for clean writing experience
    ".cm-gutters": {
        display: "none",
        backgroundColor: "rgb(var(--color-surface-primary) / 1)",
        color: "rgb(var(--color-text-tertiary) / 1)",
    },
    ".cm-panels": {
        backgroundColor: "rgb(var(--color-surface-secondary) / 1)",
        color: "rgb(var(--color-text-secondary) / 1)",
        borderColor: "rgb(var(--color-border) / 1)",
    },
    ".cm-searchMatch": {
        backgroundColor: "rgb(var(--color-accent-muted) / 0.55)",
        outline: "1px solid rgb(var(--color-accent-primary) / 0.35)",
    },
    // Header styling to make them look "rendered"
    ".cm-header-1": { fontSize: "1.8em", fontWeight: "bold", color: "var(--color-text-primary)" },
    ".cm-header-2": { fontSize: "1.5em", fontWeight: "bold", color: "var(--color-text-primary)" },
    ".cm-header-3": { fontSize: "1.3em", fontWeight: "bold", color: "var(--color-text-primary)" },
    ".cm-header-4": { fontSize: "1.2em", fontWeight: "bold", color: "var(--color-text-primary)" },
    ".cm-strong": { fontWeight: "bold" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-quote": { color: "var(--color-text-tertiary)", fontStyle: "italic" },
    ".cm-link": { color: "var(--color-accent-primary)", textDecoration: "underline" },
});

const inlineDiffTheme = EditorView.theme({
    ".cm-deletedChunk": {
        paddingLeft: "0",
        backgroundColor: "rgb(244 63 94 / 0.08)",
    },
    ".cm-deletedChunk .cm-line": {
        color: "inherit",
        opacity: "0.82",
    },
    ".cm-deletedChunk .cm-deletedText": {
        background: "linear-gradient(rgb(244 63 94 / 0.34), rgb(244 63 94 / 0.34)) bottom / 100% 2px no-repeat",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
        backgroundColor: "rgb(16 185 129 / 0.08)",
    },
    "&.cm-merge-b .cm-changedText": {
        background: "linear-gradient(rgb(16 185 129 / 0.38), rgb(16 185 129 / 0.38)) bottom / 100% 2px no-repeat",
    },
    "&.cm-merge-b .cm-deletedText": {
        backgroundColor: "rgb(244 63 94 / 0.14)",
    },
    ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": {
        textDecoration: "none",
    },
    ".cm-collapsedLines": {
        color: "rgb(var(--color-text-tertiary) / 1)",
        background: "rgb(var(--color-surface-secondary) / 0.65)",
        borderRadius: "8px",
        margin: "4px 0",
    },
});

// Syntax highlighting adjustments
const markdownHighlighting = HighlightStyle.define([
    { tag: tags.heading1, class: "cm-header-1" },
    { tag: tags.heading2, class: "cm-header-2" },
    { tag: tags.heading3, class: "cm-header-3" },
    { tag: tags.heading4, class: "cm-header-4" },
    { tag: tags.strong, class: "cm-strong" },
    { tag: tags.emphasis, class: "cm-em" },
    { tag: tags.quote, class: "cm-quote" },
    { tag: tags.link, class: "cm-link" },
    { tag: tags.monospace, color: "rgb(var(--color-status-warning) / 1)", fontFamily: "monospace" }, // Inline code
]);

const readSelectedText = (view: EditorView) => {
    const ranges: string[] = [];
    for (const range of view.state.selection.ranges) {
        if (!range.empty) {
            ranges.push(view.state.sliceDoc(range.from, range.to));
        }
    }
    return ranges.join('\n');
};

const selectWholeDocument = (view: EditorView) => {
    view.focus();
    view.dispatch({
        selection: { anchor: 0, head: view.state.doc.length },
        scrollIntoView: true,
    });
    return true;
};

const editorInteractionHandlers = EditorView.domEventHandlers({
    contextmenu(event) {
        event.stopPropagation();
        return false;
    },
    keydown(event, view) {
        event.stopPropagation();
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            return selectWholeDocument(view);
        }
        return false;
    },
    copy(event, view) {
        const text = readSelectedText(view);
        if (!text || !event.clipboardData) return false;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopPropagation();
        return true;
    },
    cut(event, view) {
        const text = readSelectedText(view);
        if (!text || !event.clipboardData) return false;
        event.clipboardData.setData('text/plain', text);
        view.dispatch(view.state.replaceSelection(''));
        event.preventDefault();
        event.stopPropagation();
        return true;
    },
    paste(event, view) {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        view.dispatch({
            ...view.state.replaceSelection(text),
            scrollIntoView: true,
        });
        event.preventDefault();
        event.stopPropagation();
        return true;
    },
});

export function CodeMirrorEditor({ value, onChange, className, diffOriginalValue }: CodeMirrorEditorProps) {
    const handleChange = React.useCallback((val: string, _viewUpdate: any) => {
        onChange(val);
    }, [onChange]);

    const collapseLargeDiff = typeof diffOriginalValue === 'string'
        && Math.max(diffOriginalValue.length, value.length) > 80000;

    const extensions = React.useMemo(() => {
        const nextExtensions = [
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
            obsidianTheme,
            syntaxHighlighting(markdownHighlighting),
            editorInteractionHandlers,
        ];

        if (typeof diffOriginalValue === 'string') {
            const shouldCollapseUnchanged = collapseLargeDiff
                ? { margin: 4, minSize: 16 }
                : undefined;
            nextExtensions.push(
                unifiedMergeView({
                    original: diffOriginalValue,
                    gutter: false,
                    highlightChanges: true,
                    allowInlineDiffs: true,
                    mergeControls: false,
                    syntaxHighlightDeletions: false,
                    diffConfig: {
                        scanLimit: 10000,
                        timeout: 120,
                    },
                    collapseUnchanged: shouldCollapseUnchanged,
                }),
                inlineDiffTheme
            );
        }

        return nextExtensions;
    }, [collapseLargeDiff, diffOriginalValue]);

    return (
        <div className={`h-full min-h-0 w-full overflow-hidden flex flex-col ${className || ''}`}>
            <CodeMirror
                value={value}
                className="flex-1 min-h-0"
                style={{ height: '100%' }}
                height="100%"
                extensions={extensions}
                onChange={handleChange}
                basicSetup={{
                    lineNumbers: false,
                    foldGutter: false,
                    highlightActiveLine: false,
                    drawSelection: false,
                    dropCursor: true,
                    allowMultipleSelections: false,
                    indentOnInput: true,
                    bracketMatching: true,
                    closeBrackets: true,
                    autocompletion: true,
                    rectangularSelection: false,
                    crosshairCursor: false,
                    highlightActiveLineGutter: false,
                    highlightSelectionMatches: true,
                    closeBracketsKeymap: true,
                    defaultKeymap: true,
                    searchKeymap: true,
                    historyKeymap: true,
                    foldKeymap: true,
                    completionKeymap: true,
                    lintKeymap: true,
                }}
            />
        </div>
    );
}
