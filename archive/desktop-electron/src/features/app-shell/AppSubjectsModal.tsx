import type { ReactNode } from 'react';

interface AppSubjectsModalProps {
  children: ReactNode;
  close: () => void;
}

export function AppSubjectsModal({ children, close }: AppSubjectsModalProps) {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="资产库"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div className="h-[min(860px,calc(100vh-48px))] w-[min(1180px,calc(100vw-40px))] overflow-hidden rounded-2xl bg-white shadow-2xl">
        {children}
      </div>
    </div>
  );
}
