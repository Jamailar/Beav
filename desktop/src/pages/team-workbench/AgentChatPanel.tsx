import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { MessageItem, type Message } from '../../components/MessageItem';
import { ChatComposer } from '../../components/ChatComposer';
import type { TeamWorkbenchMember, TeamWorkbenchMessage, TeamWorkbenchReport } from './teamWorkbenchTypes';
import { messagesForMember } from './teamWorkbenchUtils';

interface AgentChatPanelProps {
  member: TeamWorkbenchMember;
  mailbox: TeamWorkbenchMessage[];
  reports: TeamWorkbenchReport[];
  isActive: boolean;
  disabled?: boolean;
  onSendMessage: (body: string) => Promise<void>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const AgentChatPanel = memo(({
  member,
  mailbox,
  reports,
  isActive,
  disabled = false,
  onSendMessage,
}: AgentChatPanelProps) => {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const persistedMessages = useMemo(() => messagesForMember(member.id, mailbox, reports).map((message) => (
    message.memberActor && message.memberActor.memberId === member.id
      ? {
        ...message,
        memberActor: {
          ...message.memberActor,
          displayName: member.displayName,
        },
      }
      : message
  )), [mailbox, member.displayName, member.id, reports]);

  const messages = useMemo(() => {
    const persistedIds = new Set(persistedMessages.map((message) => message.id));
    return [
      ...persistedMessages,
      ...optimisticMessages.filter((message) => !persistedIds.has(message.id)),
    ].sort((left, right) => Number(left.processingStartedAt || 0) - Number(right.processingStartedAt || 0));
  }, [optimisticMessages, persistedMessages]);

  useEffect(() => {
    if (!isActive) return;
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isActive, messages.length]);

  const submit = async () => {
    const body = input.trim();
    if (!body || isSending || disabled) return;
    const now = Date.now();
    const optimistic: Message = {
      id: `optimistic-${member.id}-${now}`,
      role: 'user',
      messageType: 'reply',
      content: body,
      displayContent: body,
      tools: [],
      timeline: [],
      suppressPendingIndicator: true,
      processingStartedAt: now,
      processingFinishedAt: now,
    };
    setOptimisticMessages((prev) => [...prev, optimistic]);
    setInput('');
    setError(null);
    setIsSending(true);
    try {
      await onSendMessage(body);
      setOptimisticMessages((prev) => prev.filter((message) => message.id !== optimistic.id));
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError || '发送失败');
      setError(message);
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyMessage = async (messageId: string, content: string) => {
    const ok = await copyText(content);
    if (!ok) return;
    setCopiedMessageId(messageId);
    window.setTimeout(() => setCopiedMessageId(null), 1200);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center px-6 text-center text-sm leading-6 text-text-tertiary">
            等待任务或消息
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((message) => (
              <MessageItem
                key={message.id}
                msg={message}
                copiedMessageId={copiedMessageId}
                onCopyMessage={handleCopyMessage}
                workflowVariant="compact"
                workflowEmphasis="thoughts-first"
                workflowAutoHideWhenComplete
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2">
        {error ? (
          <div className="mb-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}
        <ChatComposer
          value={input}
          onValueChange={setInput}
          onSubmit={submit}
          placeholder={disabled ? `${member.displayName} 已停用` : `发送消息给 ${member.displayName}...`}
          isBusy={isSending}
          disabled={disabled}
          showCancelWhenBusy={false}
          textareaMaxHeight={140}
        />
      </div>
    </div>
  );
});
