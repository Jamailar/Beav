/**
 * Legacy compatibility shim.
 *
 * 历史上这里导出了基于 LangGraph 的 LangGraphChatService。
 * 迁移后统一改为 pi-agent-core 实现，保留类名避免旧调用方崩溃。
 */

import { PiChatService } from './pi/PiChatService';

export class LangGraphChatService extends PiChatService {}

