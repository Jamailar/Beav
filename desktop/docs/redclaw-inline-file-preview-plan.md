---
doc_type: plan
execution_status: not_started
last_updated: 2026-04-28
owner: redclaw-platform
scope: desktop
target_files:
  - desktop/src/pages/RedClaw.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/components/MessageItem.tsx
  - desktop/src/pages/redclaw/RedClawFilePreviewPane.tsx
  - desktop/src/utils/pathManager.ts
success_metrics:
  - AI 消息中的 Markdown 链接和裸 URL 在 RedClaw 中渲染为可点击预览按钮
  - 点击链接后不离开 RedClaw 页面，聊天区域左移，右侧显示文件预览区域
  - 关闭预览后聊天区域恢复全宽，当前对话和输入草稿不丢失
  - 普通 Chat、KnowledgeChatModal 和其他复用 Chat 的页面不改变链接行为
  - 本地图片、视频、音频、PDF、HTML 和外部网页至少各有明确预览或恢复动作
---

# RedClaw Inline File Preview Plan

## 1. Goal

在 `RedClaw` 页面内增加一个内嵌文件预览工作区：当 AI 回复中出现链接、文件路径或可渲染资源链接时，消息内不再只显示普通蓝色外链，而是渲染成一个按钮。用户点击按钮后，当前 `RedClaw` 页面切换为左右分栏：

- 左侧继续显示聊天内容、工作流和输入框。
- 右侧显示当前链接对应的文件或网页预览。
- 用户仍停留在同一个 `RedClaw` 会话里，不跳转到外部页面，不弹出覆盖聊天内容的浮层。

这个能力的产品定位不是“通用浏览器”，而是 `RedClaw` 产出物、素材、网页证据和生成文件的就地检查面板。它应该服务创作流程：AI 生成文件、引用网页、给出稿件/素材路径后，用户可以立刻在右侧检查结果，并继续让 AI 修改或解释。

## 2. Non-Goals

本次不做以下事情：

- 不把所有聊天页面的链接都改成按钮。
- 不 fork 一套 RedClaw 专用消息渲染组件。
- 不新增顶层 tool 或 AI runtime 能力。
- 不让 `MessageItem` 负责文件读取、侧栏布局或 RedClaw 状态。
- 不在第一版做完整 Office 文档解析、PDF 文本抽取或富文档编辑。
- 不把外部网页内容保存进知识库；保存/引用动作应作为后续能力接入。

## 3. Current State

当前链路是：

```text
RedClaw.tsx
  -> Chat.tsx
    -> MessageItem.tsx
      -> StreamingMarkdown.tsx
        -> react-markdown + remark-gfm
```

现有行为：

- `RedClaw.tsx` 复用通用 `Chat`，通过 `fixedSessionId` 绑定 RedClaw 上下文会话。
- `Chat.tsx` 负责消息列表、输入框、运行状态、文件上传和消息事件处理。
- `MessageItem.tsx` 负责单条消息的 Markdown、图片、视频和附件展示。
- `MessageItem.tsx` 里的 Markdown 链接当前统一渲染为：

```tsx
<a href={href} target="_blank" rel="noopener noreferrer">
  {children}
</a>
```

已有可复用能力：

- `react-markdown` + `remark-gfm` 已经负责 Markdown 链接、裸 URL autolink、表格和代码块渲染。
- `resolveAssetUrl` 已经负责把本地资源转成 Tauri 可渲染 asset URL。
- `app:open-path` 已存在，可用于系统打开路径或 URL。
- `file:show-in-folder` 已存在，可用于本地文件的文件夹显示。
- `MessageItem` 已经有图片和视频的内联渲染经验，可以复用类型判断思路。

## 4. Recommended Architecture

推荐方案：**通用 Chat 增加可选链接预览事件，RedClaw 独占启用，右侧预览布局由 RedClaw 页面管理。**

```text
┌─────────────────────────────────────────────────────────────┐
│ RedClaw.tsx                                                  │
│                                                             │
│ state: previewTarget                                        │
│ state: previewPaneWidth                                     │
│                                                             │
│ ┌───────────────────────────────┬─────────────────────────┐ │
│ │ Chat.tsx                       │ RedClawFilePreviewPane  │ │
│ │ linkRenderMode=preview-button  │ target=previewTarget    │ │
│ │ onMessageLinkPreview=handler   │                         │ │
│ └───────────────────────────────┴─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

职责边界：

| Layer | Responsibility | Must Not Do |
| --- | --- | --- |
| `MessageItem` | 把链接渲染为按钮，点击时上抛结构化 target | 不管理侧栏、不读取文件、不知道 RedClaw 布局 |
| `Chat` | 透传链接渲染模式和点击回调 | 不保存预览状态、不改变其他页面行为 |
| `RedClaw` | 保存当前预览对象，切换左右分栏，协调技能面板/历史抽屉 | 不解析 Markdown、不读取大文件 |
| `RedClawFilePreviewPane` | 根据 target 渲染预览、操作栏、错误态 | 不影响聊天消息状态、不触发 AI runtime |
| Host IPC | 系统打开、显示文件夹，后续可加受限文本读取 | 不做 UI 状态管理 |

## 5. Product Interaction

### 5.1 Default State

没有打开文件时，`RedClaw` 保持当前布局：

```text
┌──────────────────────────────────────────────┐
│ RedClaw header / history / skill trigger      │
├──────────────────────────────────────────────┤
│ Chat content                                  │
│ Composer                                      │
└──────────────────────────────────────────────┘
```

### 5.2 Preview State

点击 AI 消息中的链接按钮后：

```text
┌────────────────────────────────────────────────────────────┐
│ RedClaw header / history / skill trigger                    │
├────────────────────────────────────┬───────────────────────┤
│ Chat content                        │ File preview pane     │
│ - messages                          │ - title/action bar    │
│ - workflow timeline                 │ - preview body        │
│ - composer                          │ - fallback actions    │
└────────────────────────────────────┴───────────────────────┘
```

交互要求：

1. 点击链接按钮后右侧预览区域出现，聊天区域左移。
2. 输入框仍然可用，不能被右侧区域遮挡。
3. 用户连续点击不同链接时，右侧区域直接替换内容。
4. 关闭右侧区域后，聊天区域恢复全宽。
5. 当前会话、消息滚动、输入草稿、运行状态不应被重置。
6. 右侧预览区域打开时，如果技能面板抽屉已打开，应自动收起技能面板，避免两个右侧面板竞争。
7. 历史抽屉仍可打开，但历史抽屉是临时覆盖层；关闭后预览状态保留。

### 5.3 Link Button Behavior

只在 `RedClaw` 的 AI 消息中启用按钮化链接：

- AI 消息中的 Markdown 链接：`[文件名](path-or-url)` 渲染为按钮。
- AI 消息中的裸 URL：由 `remark-gfm` autolink 后同样渲染为按钮。
- 用户消息中的链接默认保持普通链接，避免用户输入内容被过度转义成工作台动作。
- 思考内容中的链接是否按钮化可保持与 AI 正文一致，因为 `MessageItem` 目前也用同一 Markdown 渲染链路展示 thought。

按钮内容优先级：

1. Markdown 链接文本。
2. URL 的文件名部分。
3. 域名。
4. `打开链接`。

按钮视觉：

- 使用紧凑 inline-flex button，不撑高段落。
- 左侧用 lucide 图标表达类型：`Image`, `Video`, `FileText`, `Globe`, `File`, `ExternalLink`。
- 长文件名单行省略，hover title 显示完整路径/URL。
- 当前正在预览的链接可以显示 selected 状态。

## 6. Data Model

新增 renderer 类型，建议放在 `MessageItem.tsx` 附近并从 `Chat.tsx` 引用；如果后续复用变多，再迁移到 `desktop/src/types.d.ts` 或 `desktop/src/pages/redclaw/types.ts`。

```ts
export type ChatMessageLinkKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'html'
  | 'text'
  | 'web'
  | 'unknown';

export interface ChatMessageLinkTarget {
  href: string;
  label: string;
  kind: ChatMessageLinkKind;
  resolvedUrl: string;
  isLocal: boolean;
  sourceMessageId: string;
}
```

`href` 是 Markdown 原始链接值。  
`resolvedUrl` 是 `resolveAssetUrl(href)` 后的可渲染地址。  
`isLocal` 来自 `isLocalAssetUrl(href)` 或 `file:` 判断。  
`kind` 由 URL/path 后缀、协议和 MIME hint 推断，不依赖 AI 文本语义。

## 7. File Type Detection

第一版使用轻量 deterministic 推断，不调用 host 扫描文件内容。

| Kind | Match |
| --- | --- |
| `image` | `.png .jpg .jpeg .webp .gif .bmp .svg .avif` |
| `video` | `.mp4 .webm .mov .m4v` |
| `audio` | `.mp3 .wav .m4a .aac .ogg .flac` |
| `pdf` | `.pdf` |
| `html` | `.html .htm` 或 `text/html` hint |
| `text` | `.txt .md .markdown .json .csv .tsv .yaml .yml .log .xml` |
| `web` | `http://` 或 `https://` 且不是明显媒体后缀 |
| `unknown` | 其他本地文件或未知 URL |

需要注意：

- 查询串和 hash 不应影响后缀判断，比如 `demo.pdf?token=...` 仍应识别为 PDF。
- Windows 路径、POSIX 路径、`file://`、Tauri asset URL 都要通过已有 path helper 归一化。
- 禁止 `javascript:`，未知协议不进入预览 pane。

## 8. Preview Pane Design

新增文件：

```text
desktop/src/pages/redclaw/RedClawFilePreviewPane.tsx
```

Props：

```ts
interface RedClawFilePreviewPaneProps {
  target: ChatMessageLinkTarget | null;
  onClose: () => void;
  onOpenExternal: (target: ChatMessageLinkTarget) => void | Promise<void>;
  onRevealInFolder: (target: ChatMessageLinkTarget) => void | Promise<void>;
}
```

Pane 结构：

```text
┌──────────────────────────────┐
│ title / kind / actions        │
├──────────────────────────────┤
│ preview body                  │
│ - image/video/audio/iframe    │
│ - unsupported fallback        │
├──────────────────────────────┤
│ optional status/error footer  │
└──────────────────────────────┘
```

Header actions：

- 复制链接/路径。
- 在系统中打开。
- 在文件夹中显示，仅本地文件显示。
- 关闭预览。

Body rendering：

| Kind | Renderer | Notes |
| --- | --- | --- |
| `image` | `<img>` | `object-contain`, no autoplay, no full-screen overlay in first version |
| `video` | `<video controls preload="metadata">` | 不自动下载完整视频 |
| `audio` | `<audio controls>` | 预留文件信息区域 |
| `pdf` | `<iframe>` | 浏览器/Tauri WebView 能渲染则直接显示 |
| `html` | `<iframe sandbox="">` or normal iframe depending compatibility | 本地 HTML 可能需要允许 same-origin；第一版以可渲染为优先 |
| `web` | `<iframe>` | 失败时显示恢复动作 |
| `text` | 第一版 iframe/fallback；后续可加 host text preview | 避免无上限读取大文件 |
| `unknown` | fallback card | 显示文件名和操作按钮 |

外部网页 iframe 风险：

- 很多网站会因 `X-Frame-Options` 或 CSP 拒绝嵌入。
- iframe 的 load/error 信号不完全可靠。
- 第一版应提供明确 fallback：`无法在 RedClaw 内预览时，请在系统浏览器打开`。

## 9. Layout Implementation

在 `RedClaw.tsx` 的 Chat 容器外层增加分栏状态。

推荐 CSS/Tailwind 形态：

```tsx
<div
  className={clsx(
    'relative flex min-h-0 flex-1 overflow-hidden',
    previewTarget ? 'gap-3' : ''
  )}
>
  <div className={clsx('min-w-0 flex-1 transition-[width] duration-200')}>
    <Chat ... />
  </div>
  {previewTarget && (
    <RedClawFilePreviewPane
      target={previewTarget}
      onClose={() => setPreviewTarget(null)}
      ...
    />
  )}
</div>
```

右侧宽度：

- desktop 默认 `420px`。
- 最小 `360px`，最大 `560px`。
- 低于 `1180px` 视窗时可使用 `minmax(340px, 38vw)`，保证 Chat 仍能阅读。
- 首版可以固定宽度，不强制做拖拽 resize；拖拽 resize 可在后续接入 `react-resizable-panels`。

响应式策略：

- 当前 Tauri window `minWidth` 是 `1180`，桌面端足够做双栏。
- 如果未来允许更窄窗口，小于 `960px` 时可以把预览 pane 改为底部 sheet 或临时 overlay，但不作为本次主路径。

## 10. File-Level Implementation Plan

### 10.1 `MessageItem.tsx`

新增 props：

```ts
interface MessageItemProps {
  ...
  linkRenderMode?: 'default' | 'preview-button';
  onPreviewLink?: (target: ChatMessageLinkTarget) => void;
}
```

新增 helpers：

- `inferLinkKind(href: string): ChatMessageLinkKind`
- `labelFromLink(href: string, children: React.ReactNode): string`
- `buildMessageLinkTarget(href, children, msg.id): ChatMessageLinkTarget | null`
- `isPreviewableLinkProtocol(href: string): boolean`

修改 Markdown `a` renderer：

- 默认模式保持现有 `<a>`。
- `preview-button` 模式下：
  - 阻止默认跳转。
  - 构建 `ChatMessageLinkTarget`。
  - 调用 `onPreviewLink(target)`。
  - 如果 target 无效，回退为普通链接或禁用按钮。

关键约束：

- 不解析整段消息文本。
- 不新增 `useEffect` 扫描 DOM。
- 不把 URL 正则塞进 RedClaw 页面。
- 不改变 `img` Markdown 的现有渲染行为；图片 Markdown 仍可直接显示，链接按钮主要处理普通 links。

### 10.2 `Chat.tsx`

新增 props：

```ts
messageLinkRenderMode?: 'default' | 'preview-button';
onMessageLinkPreview?: (target: ChatMessageLinkTarget) => void;
```

在 `MessageItem` 调用处透传：

```tsx
<MessageItem
  ...
  linkRenderMode={messageLinkRenderMode}
  onPreviewLink={onMessageLinkPreview}
/>
```

关键约束：

- `Chat` 不保存 preview target。
- 不让普通页面默认开启按钮模式。
- 不影响 `showMessageAttachments`、workflow timeline、copy message 等既有行为。

### 10.3 `RedClaw.tsx`

新增状态：

```ts
const [previewTarget, setPreviewTarget] = useState<ChatMessageLinkTarget | null>(null);
```

新增 handler：

```ts
const handlePreviewLink = useCallback((target: ChatMessageLinkTarget) => {
  setSidebarCollapsed(true);
  setPreviewTarget(target);
}, []);
```

传给 Chat：

```tsx
<Chat
  ...
  messageLinkRenderMode="preview-button"
  onMessageLinkPreview={handlePreviewLink}
/>
```

接入 preview pane：

```tsx
{previewTarget && (
  <RedClawFilePreviewPane
    target={previewTarget}
    onClose={() => setPreviewTarget(null)}
    onOpenExternal={handleOpenPreviewExternal}
    onRevealInFolder={handleRevealPreviewInFolder}
  />
)}
```

操作 handlers：

- `handleOpenPreviewExternal`: 调用 `window.ipcRenderer.openPath(target.href)` 或 `invoke('app:open-path')`。
- `handleRevealPreviewInFolder`: 调用 `window.ipcRenderer.file.showInFolder({ source: target.href })`。
- `handleCopyPreviewTarget`: 可放在 pane 内直接用 `navigator.clipboard.writeText`。

关键约束：

- `previewTarget` 改变不能改变 `key={`redclaw:${chatRefreshKey}`}`，否则会重挂 Chat。
- 不能把右侧 pane 做成 fixed overlay；必须参与 RedClaw 内容区域布局。
- 不要让 preview pane 覆盖输入框。

### 10.4 `RedClawFilePreviewPane.tsx`

组件职责：

- 显示标题、类型、原始路径/URL。
- 根据 `target.kind` 渲染预览。
- 提供复制、系统打开、显示文件夹、关闭。
- 处理 iframe fallback 和未知文件。

建议内部状态：

```ts
const [iframeFailed, setIframeFailed] = useState(false);
const [copied, setCopied] = useState(false);
```

注意：

- iframe `onError` 不一定可靠；UI 不应依赖它作为唯一失败判断。
- 外部网页可提供一个短超时提示，但不要自动判定失败覆盖页面。
- 图片和视频加载失败时展示 fallback card。

## 11. Existing Libraries vs Self-Built Code

必须使用现成库/现有能力：

- Markdown parsing: `react-markdown` + `remark-gfm`。
- Local asset conversion: `resolveAssetUrl` + Tauri `convertFileSrc`。
- Browser-native preview: `img`, `video`, `audio`, `iframe`。
- Icons: `lucide-react`。
- Host open/reveal: existing `app:open-path`, `file:show-in-folder`。

需要自研：

- RedClaw-only link button rendering mode。
- `ChatMessageLinkTarget` contract。
- Link kind inference。
- RedClaw split layout and preview state.
- `RedClawFilePreviewPane` UI.
- Preview fallback and recovery actions.

不应自研：

- Markdown parser.
- URL autolink parser.
- Full PDF renderer.
- Video/audio decoder.
- Generic embedded browser.

## 12. Performance Strategy

1. **Lazy creation**  
   `RedClawFilePreviewPane` 只在用户点击链接后挂载。

2. **No chat remount**  
   预览状态更新不能修改 Chat 的 `key`，避免消息列表和输入框被重置。

3. **Native media loading**  
   视频使用 `preload="metadata"`；不 autoplay。

4. **No eager file hydration**  
   第一版不主动读取本地文本文件内容，避免大文件阻塞 renderer 或引入无上限 IPC。

5. **Stable layout dimensions**  
   右侧 pane 使用固定/受限宽度，避免媒体加载后造成横向抖动。

6. **Memoized Markdown components**  
   `MessageItem` 的 `markdownComponents` 继续用 `useMemo`，新增 link renderer 的依赖只包含必要 handlers。

7. **Scrollable boundaries**  
   Chat 和 preview pane 各自 `min-h-0 overflow-hidden`，pane body 单独滚动，避免整页滚动冲突。

## 13. Security And Safety

允许协议：

- `http:`
- `https:`
- `file:`
- `data:` for renderable existing media
- `blob:`
- existing local asset source handled by `resolveAssetUrl`

禁止协议：

- `javascript:`
- `vbscript:`
- unknown custom protocols, unless later explicitly allowlisted

本地文件规则：

- Renderer 不手写 `file://`。
- 使用 `resolveAssetUrl` 生成预览 URL。
- 系统打开和显示文件夹走 existing IPC，不绕过 bridge。

外部网页规则：

- iframe 只用于用户点击后的显式预览。
- 系统打开按钮始终可用。
- 不把网页内容自动注入 AI 上下文。

## 14. Alternatives

| Option | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| A. 全局改 `MessageItem` 链接 | 所有 Chat 链接都变按钮 | 最快 | 影响主聊天、知识库、弹窗聊天，回归风险高 | 不推荐 |
| B. Fork RedClaw 消息组件 | RedClaw 自己维护一套消息 UI | 隔离强 | 复制消息、附件、workflow timeline、图片菜单逻辑，维护成本高 | 不推荐 |
| C. Chat 可选能力 + RedClaw 管布局 | 通用 Chat 只透传事件，RedClaw 启用按钮和右栏 | 改动小、边界清晰、可复用 | 需要设计 props contract | 推荐 |
| D. 直接用系统打开 | 点击后打开外部 app/browser | 实现最少 | 离开 RedClaw，无法边看边聊 | 不满足目标 |
| E. 右侧 fixed drawer overlay | 预览浮在聊天上方 | 快速 | 遮挡聊天，不符合“聊天区域左移” | 不推荐 |

推荐选项 C。

## 15. Implementation Sequence

本计划可以一个原子提交完成，提交主题建议：

```text
Add RedClaw inline file preview pane
```

执行顺序：

1. 在 `MessageItem.tsx` 增加 link target 类型、kind 推断和 preview-button renderer。
2. 在 `Chat.tsx` 增加 props 并透传。
3. 新增 `RedClawFilePreviewPane.tsx`，先实现 image/video/audio/pdf/web/unknown fallback。
4. 在 `RedClaw.tsx` 增加 `previewTarget` 状态和左右分栏布局。
5. 接入系统打开、复制、显示文件夹动作。
6. 做样式收口：保证右栏宽度、Chat 宽度、输入框和消息都不重叠。
7. 验证普通 Chat 链接仍是普通外链。
8. 运行前端构建或类型检查。

## 16. Verification Plan

### 16.1 Manual UI Checks

在 RedClaw 会话里用 AI 或手动消息准备以下内容：

```md
[本地图片](/Users/Jam/.redbox/demo/image.png)
[本地视频](/Users/Jam/.redbox/demo/video.mp4)
[PDF 文档](/Users/Jam/.redbox/demo/report.pdf)
[网页](https://example.com)
https://example.com/plain-url
```

检查：

- 链接在 AI 消息里显示为按钮。
- 点击图片后右侧显示图片。
- 点击视频后右侧显示视频播放器。
- 点击 PDF/网页后右侧显示 iframe 或 fallback。
- 连续点击不同链接时右侧内容更新。
- 关闭右侧 pane 后 Chat 恢复全宽。
- 输入框内容在打开/关闭预览时不丢失。
- Chat 滚动位置不因预览切换明显跳动。
- 技能面板打开时点击链接，技能面板收起，预览 pane 显示。

### 16.2 Regression Checks

- 普通 `Chat` 页面链接仍显示为普通 `<a>`。
- `KnowledgeChatModal` 复用 Chat 时不出现 RedClaw link buttons。
- AI 消息里的图片 Markdown 仍能内联显示。
- 用户消息中的链接不被 RedClaw 强制变成预览按钮，除非后续明确需要。

### 16.3 Commands

最低验证：

```bash
cd desktop
pnpm build
```

如果改动涉及 TypeScript 类型但 build 较慢，可先跑：

```bash
cd desktop
pnpm exec tsc --noEmit
```

如果新增或修改 IPC，不适用于本计划第一版；若后续增加 text preview IPC，则还需要：

```bash
cd desktop
pnpm ipc:inventory
cd src-tauri
cargo check
```

## 17. Future Extensions

后续可继续扩展，但不进入第一版原子提交：

1. **Resizable pane**  
   用 `react-resizable-panels` 或局部 drag handle 允许用户调整右侧宽度。

2. **Text file preview IPC**  
   新增受限 host action，例如 `file:read-preview`：
   - 限制最大读取字节数。
   - 返回 `truncated`。
   - 只允许 workspace/app asset scope 或用户显式链接文件。

3. **Artifact actions**  
   在预览栏增加“加入知识库”“作为素材加入稿件”“让 RedClaw 修改这个文件”等动作。

4. **Preview history**  
   在 pane 内保留最近打开的 5 个链接，便于在多个产物之间来回检查。

5. **Structured artifact links from runtime**  
   长期应让 AI runtime/tool result 输出结构化 artifacts，消息渲染层直接拿 artifact metadata，而不是只靠 Markdown href 推断类型。

## 18. Acceptance Criteria

实现完成后必须满足：

- RedClaw AI 消息链接按钮化，并能打开右侧预览。
- 右侧预览是页面内分栏，不是覆盖层。
- Chat 不重挂、不清空、不丢输入。
- 普通 Chat 页面不受影响。
- 本地媒体和网页都有明确预览或恢复路径。
- 没有新增不必要的 runtime/tool/IPC surface。
- 改动保持在一个原子提交内。
