import { useCallback, useEffect, useState } from 'react';

export function useSubjectsModal() {
  const [subjectsModalOpen, setSubjectsModalOpen] = useState(false);

  const openSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(true);
  }, []);

  const closeSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(false);
  }, []);

  useEffect(() => {
    if (!subjectsModalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSubjectsModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSubjectsModal, subjectsModalOpen]);

  return {
    subjectsModalOpen,
    openSubjectsModal,
    closeSubjectsModal,
  };
}
