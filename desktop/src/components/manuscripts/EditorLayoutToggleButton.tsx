import clsx from 'clsx';

type EditorLayoutToggleButtonProps = {
    kind: 'timeline' | 'materials';
    collapsed: boolean;
    onClick: () => void;
    title: string;
};

export function EditorLayoutToggleButton({
    kind,
    collapsed,
    onClick,
    title,
}: EditorLayoutToggleButtonProps) {
    const expanded = !collapsed;

    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            aria-pressed={expanded}
            className={clsx(
                'inline-flex h-7 w-7 items-center justify-center text-white transition',
                expanded
                    ? 'text-white/92'
                    : 'text-white/48 hover:text-white/82'
            )}
        >
            <LayoutGlyph kind={kind} />
        </button>
    );
}

function LayoutGlyph({ kind }: { kind: 'timeline' | 'materials' }) {
    return (
        <svg viewBox="0 0 24 18" className="h-[14px] w-[20px]" aria-hidden="true" fill="none">
            <rect x="1.5" y="1.5" width="21" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            {kind === 'timeline' ? (
                <rect x="4" y="10.5" width="16" height="3.5" rx="1.2" fill="currentColor" />
            ) : (
                <rect x="5" y="4" width="4.5" height="10" rx="1.2" fill="currentColor" />
            )}
        </svg>
    );
}
