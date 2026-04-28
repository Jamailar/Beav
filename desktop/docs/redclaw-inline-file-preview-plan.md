---
doc_type: plan
execution_status: completed
last_updated: 2026-04-28
owner: redclaw-platform
scope: desktop
target_files:
  - desktop/src/pages/RedClaw.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/components/MessageItem.tsx
  - desktop/src/pages/redclaw/RedClawFilePreviewPane.tsx
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/types.d.ts
  - desktop/src-tauri/src/commands/file_ops.rs
  - desktop/src-tauri/src/main.rs
  - desktop/prompts/library/runtime/agents/redclaw/base.txt
  - desktop/src/pages/redclaw/config.ts
  - desktop/src/utils/pathManager.ts
  - desktop/shared/localAsset.ts
success_metrics:
  - AI 消息中的 Markdown 链接和裸 URL 在 RedClaw 中渲染为文件预览卡片
  - 点击文件卡片后不离开 RedClaw 页面，聊天区域左移，右侧显示文件预览区域
  - 关闭预览后聊天区域恢复全宽，当前对话和输入草稿不丢失
  - 普通 Chat、KnowledgeChatModal 和其他复用 Chat 的页面不改变链接行为
  - 本地图片、视频、音频、PDF、HTML 和外部网页至少各有明确预览或恢复动作
  - AI 输出中的裸文件路径、workspace 相对路径和 app 虚拟路径能够进入卡片与 host resolver 流程
  - Windows 盘符路径、UNC 路径、file URL、redbox-asset URL、local-file URL、POSIX 绝对路径、普通 http(s) URL 均能被正确识别、归一化和预览或恢复
---

# RedClaw Inline File Preview Plan

## 1. Goal

在 `RedClaw` 页面内增加一个内嵌文件预览工作区：当 AI 回复中出现链接、文件路径或可渲染资源链接时，消息内不再只显示普通蓝色外链，而是渲染成文件卡片。用户点击卡片里的 `打开` 后，当前 `RedClaw` 页面切换为左右分栏：

- 左侧继续显示聊天内容、工作流和输入框。
- 右侧显示当前链接对应的文件或网页预览。
- 用户仍停留在同一个 `RedClaw` 会话里，不跳转到外部页面，不弹出覆盖聊天内容的浮层。

这个能力的产品定位不是“通用浏览器”，而是 `RedClaw` 产出物、素材、网页证据和生成文件的就地检查面板。它应该服务创作流程：AI 生成文件、引用网页、给出稿件/素材路径后，用户可以立刻在右侧检查结果，并继续让 AI 修改或解释。

## 2. Non-Goals

本次不做以下事情：

- 不把所有聊天页面的链接都改成文件卡片。
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
- `desktop/shared/localAsset.ts` 已经提供 `isWindowsAbsoluteLocalPath`、`isUncLocalPath`、`isLocalAssetSource`、`extractLocalAssetPathCandidate`、`toRedboxAssetUrl` 等本地资源识别能力。
- `app:open-path` 已存在，可用于系统打开路径或 URL。
- `file:show-in-folder` 已存在，可用于本地文件的文件夹显示。
- `MessageItem` 已经有图片和视频的内联渲染经验，可以复用类型判断思路。
- Rust 侧 `file_url_for_path`、`asset_preview_url_from_result` 已经有 Windows drive path 相关测试，计划实现必须沿用这些语义，不要在 renderer 单独发明另一套路径格式。
- Rust 侧新增 `file:preview-resolve` 作为预览路径解析入口；renderer 只负责展示和触发，不负责猜测 workspace、media、knowledge、manuscripts、cover、redclaw 等 app 内目录。

## 4. Recommended Architecture

推荐方案：**通用 Chat 增加可选链接预览事件和内部 inline side panel，RedClaw 独占启用，文件预览必须发生在中间聊天区域内部。**

```text
┌─────────────────────────────────────────────────────────────┐
│ RedClaw.tsx                                                  │
│                                                             │
│ state: previewTarget                                        │
│ state: previewPaneWidth                                     │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Chat.tsx                                                │ │
│ │ linkRenderMode=preview-card                             │ │
│ │ onMessageLinkPreview=handler                            │ │
│ │ inlineSidePanel=<RedClawFilePreviewPane />              │ │
│ │                                                         │ │
│ │ ┌───────────────────────┬─────────────────────────────┐ │ │
│ │ │ messages + composer   │ file preview pane           │ │ │
│ │ └───────────────────────┴─────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────┘ │
│ RedClawSidebar remains an overlay/tool drawer, not preview │
└─────────────────────────────────────────────────────────────┘
```

职责边界：

| Layer | Responsibility | Must Not Do |
| --- | --- | --- |
| `MessageItem` | 把链接渲染为文件卡片，点击时上抛结构化 target | 不管理侧栏、不读取文件、不知道 RedClaw 布局 |
| `Chat` | 透传链接渲染模式和点击回调；承载中间聊天区域内部的 `inlineSidePanel` 左右分栏 | 不保存预览 target、不改变其他页面行为、不占用 RedClaw 技能面板层 |
| `RedClaw` | 保存当前预览对象，把 `RedClawFilePreviewPane` 作为 `Chat.inlineSidePanel` 传入 | 不解析 Markdown、不读取大文件、不用文件预览折叠技能面板 |
| `RedClawFilePreviewPane` | 根据 target 渲染预览、操作栏、错误态 | 不影响聊天消息状态、不触发 AI runtime |
| Host IPC | 系统打开、显示文件夹，后续可加受限文本读取 | 不做 UI 状态管理 |

第二轮补齐后，`Host IPC` 增加 `file:preview-resolve`：

- 输入：`{ source: string }`，source 可以是绝对路径、workspace 相对路径、`workspace://` / `knowledge://` / `manuscripts://` / `media://` / `cover://` / `redclaw://` 虚拟路径、`file://`、`local-file://`、`redbox-asset://asset/...`。
- 输出：`resolvedUrl`、`localPathCandidate`、`kind`、`mimeType`、`sizeBytes`、`previewText` 等结构化字段。
- 用途：点击文件卡片后先让 host 确认真实文件位置，避免 renderer 单独猜测 app 内路径。
- 文本类小文件由 host 返回 `previewText`，右侧 pane 直接渲染只读文本，避免 WebView 对 `.md` / `.txt` / `.json` 预览不稳定。

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

点击 AI 消息中的文件卡片后：

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

1. 点击文件卡片里的 `打开` 后右侧预览区域出现，聊天区域左移。
2. 输入框仍然可用，不能被右侧区域遮挡。
3. 用户连续点击不同链接时，右侧区域直接替换内容。
4. 关闭右侧区域后，聊天区域恢复全宽。
5. 当前会话、消息滚动、输入草稿、运行状态不应被重置。
6. 右侧预览区域属于 `Chat` 中间工作区内部，不得复用或挤占 RedClaw 技能面板抽屉位置，也不得因为打开文件而自动折叠技能面板。
7. 历史抽屉仍可打开，但历史抽屉是临时覆盖层；关闭后预览状态保留。

### 5.3 File Link Card Behavior

只在 `RedClaw` 的 AI 消息中启用文件链接卡片：

- AI 消息中的 Markdown 链接：`[文件名](path-or-url)` 渲染为文件卡片。
- AI 消息中的裸 URL：由 `remark-gfm` autolink 后同样渲染为文件/网页卡片。
- 用户消息中的链接默认保持普通链接，避免用户输入内容被过度转义成工作台动作。
- 思考内容中的链接是否卡片化可保持与 AI 正文一致，因为 `MessageItem` 目前也用同一 Markdown 渲染链路展示 thought。

卡片内容优先级：

1. Markdown 链接文本。
2. URL 的文件名部分。
3. 域名。
4. `打开链接`。

卡片视觉必须接近用户给出的文件卡片截图，而不是一个小型 inline pill：

```text
┌──────────────────────────────────────────────────────────────┐
│ [file icon tile]  image-semantic-retrieval-architecture-plan.md │  ↗ 打开 ˅ │
│                   文档 · MD                                  │            │
└──────────────────────────────────────────────────────────────┘
```

UI requirements:

- 卡片是 block-level attachment card，宽度跟随 AI 消息正文容器，最大宽度约 `720px`，不能只是一段文字里的小按钮。
- 卡片背景使用轻量 surface，边框低对比，圆角约 `14px`，整体视觉接近截图里的浅色文件卡片。
- 左侧是固定尺寸图标 tile，约 `52px x 52px`，图标使用 lucide：`FileText`, `Image`, `Video`, `Music`, `FileArchive`, `Globe`, `File`。
- 中间主标题显示文件名或链接标题，`font-medium/semibold`，长文件名单行省略。
- 中间副标题显示类型摘要，例如 `文档 · MD`、`图片 · PNG`、`视频 · MP4`、`网页 · example.com`、`文件 · UNKNOWN`。
- 右侧是独立操作按钮，显示 external/open 图标 + `打开` + chevron，点击主按钮直接打开右侧预览 pane。
- chevron 后续可扩展菜单；第一版可以只显示图标但不展开，或者隐藏 chevron，不能做假菜单。
- hover 状态只提高边框/背景对比，不改变卡片高度。
- 当前正在右侧预览的卡片显示 selected 状态，例如 accent border 或淡色 ring。
- 卡片内的系统打开、复制、显示文件夹等二级动作不放在消息卡片里，放到右侧 preview pane header，避免消息区域变成工具栏。
- 多个链接连续出现时渲染为纵向卡片列表，间距约 `8px`，不要挤在同一行。

### 5.4 AI Output Contract

RedClaw runtime prompt 必须要求 AI 在报告交付物时输出 Markdown 链接：

- 保存稿件、素材、导出 HTML/PDF、生成媒体或 workspace artifact 后，用 `[filename.ext](<path-or-file-url>)` 或 `[filename.ext](workspace://relative/path.ext)` 报告。
- 路径包含空格、中文、括号或 Windows 反斜杠时，Markdown destination 必须使用 angle brackets。
- 多个交付物一行一个链接，避免把重要路径埋在纯文本段落里。
- Renderer 会对明显的裸本地路径做保守 linkify，但这只是兜底，不替代 prompt contract。

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
  localPathCandidate?: string;
  sourceMessageId: string;
}
```

`href` 是 Markdown 原始链接值。  
`resolvedUrl` 是 `resolveAssetUrl(href)` 后的可渲染地址。  
`isLocal` 来自 `isLocalAssetUrl(href)` / `isLocalAssetSource(href)`，不能只看 `file:`。  
`localPathCandidate` 来自 `extractLocalAssetPathCandidate(href)`，只用于本地文件的系统打开和显示文件夹。  
`kind` 由 URL/path 后缀、协议和 MIME hint 推断，不依赖 AI 文本语义。

## 7. Path Parsing Requirements

路径解析是本功能的高风险点，必须作为实现的核心约束处理。实现不能只覆盖 macOS/POSIX 路径，也不能把 Windows 路径当普通 URL 字符串处理。

### 7.1 Accepted Input Forms

RedClaw AI 消息中的文件链接卡片必须正确处理以下输入：

| Input form | Example | Expected handling |
| --- | --- | --- |
| POSIX absolute path | `/Users/Jam/.redbox/demo/report.pdf` | 识别为 local，交给 `resolveAssetUrl` |
| POSIX path with spaces | `/Users/Jam/My Images/demo 1.png` | 保留空格语义，预览 URL 由 helper 编码 |
| Windows drive path | `C:\Users\Jam\.redconvert\spaces\default\media\demo 1.png` | 识别为 local，不被误判为 `c:` protocol |
| Windows drive path with slash | `C:/Users/Jam/.redconvert/spaces/default/media/demo 1.png` | 识别为 local，保持 drive letter |
| Windows file URL | `file:///C:/Users/Jam/My%20Images/demo%201.png` | 识别为 local file URL，解析后仍能判断后缀 |
| Windows localhost file URL | `file://localhost/C:/Users/Jam/demo.pdf` | 识别为 local，不把 `localhost` 当 UNC host |
| UNC path | `\\NAS\RedBox\assets\demo.mp4` | 识别为 local UNC，保留 server/share |
| UNC file URL | `file://NAS/RedBox/assets/demo.mp4` | 识别为 local UNC，不丢 host |
| RedBox asset URL | `redbox-asset://asset/C:/Users/Jam/demo.png` | 识别为 local asset source |
| Legacy local-file URL | `local-file:///C:/Users/Jam/demo.png` | 兼容读取并归一化 |
| HTTP URL | `https://example.com/report.pdf` | 识别为 remote，按后缀推断 kind |
| URL with query/hash | `https://example.com/report.pdf?token=abc#page=2` | 后缀判断忽略 query/hash |
| Markdown angle URL | `[报告](<file:///C:/Users/Jam/My Images/report.pdf>)` | 由 Markdown parser 处理，renderer 接收 href 后继续归一化 |

### 7.2 Required Helper Boundary

实现必须复用现有 helper：

- `desktop/shared/localAsset.ts`
  - `isWindowsAbsoluteLocalPath`
  - `isUncLocalPath`
  - `isLikelyAbsoluteLocalPath`
  - `isFileUrl`
  - `isLegacyLocalFileUrl`
  - `isRedboxAssetUrl`
  - `isLocalAssetSource`
  - `extractLocalAssetPathCandidate`
- `desktop/src/utils/pathManager.ts`
  - `resolveAssetUrl`
  - `hasRenderableAssetUrl`
  - `isLocalAssetUrl`

禁止在 `RedClaw.tsx` 或 `MessageItem.tsx` 中重新写一套“看起来能用”的本地路径 parser。可以新增轻量 wrapper，例如 `buildPreviewTargetFromHref`，但 wrapper 的本地路径判断必须调用上述 helper。

### 7.3 Windows-Specific Failure Modes To Avoid

必须重点防止以下错误：

1. **把 `C:\...` 当成 URL protocol**  
   `new URL('C:\Users\...')` 或简单 protocol regex 可能把 `C:` 当 scheme。实现应先用 `isWindowsAbsoluteLocalPath` 识别本地路径。

2. **丢失 UNC host**  
   `file://NAS/share/demo.mp4` 的 `NAS` 是 UNC host，不是普通网页域名。解析后应保留为 `//NAS/share/demo.mp4`。

3. **重复编码空格和中文路径**  
   已经是 `%20` 的 file URL 不应再次编码成 `%2520`。应通过 `extractLocalAssetPathCandidate` 解码候选路径，再交给 `convertFileSrc` / `resolveAssetUrl`。

4. **反斜杠破坏 Markdown 链接**  
   AI 如果输出 Windows 裸路径，Markdown 可能把反斜杠当 escape。Prompt 层后续可鼓励输出 `<C:\path\file.png>` 或 fenced path，但 renderer 仍要兼容实际 href 中出现的反斜杠。

5. **drive letter 前导斜杠问题**  
   `file:///C:/...` 解析得到的 pathname 可能是 `/C:/...`，归一化时需要去掉多余前导 slash。现有 helper 已处理，不能绕开。

6. **系统打开与预览 URL 混用**  
   `resolvedUrl` 用于 WebView 预览，`href` 或 local path candidate 用于 `app:open-path` / `file:show-in-folder`。不要把 Tauri asset URL 直接传给系统文件管理器。

### 7.4 Path Target Fields

为了避免混用，`ChatMessageLinkTarget` 必须保留独立的 `resolvedUrl` 与 `localPathCandidate`：

```ts
export interface ChatMessageLinkTarget {
  href: string;
  label: string;
  kind: ChatMessageLinkKind;
  resolvedUrl: string;
  isLocal: boolean;
  localPathCandidate?: string;
  sourceMessageId: string;
}
```

字段语义：

- `href`: Markdown 原始 href，用于显示、复制和 remote open fallback。
- `resolvedUrl`: `resolveAssetUrl(href)` 的结果，只用于 WebView 渲染。
- `localPathCandidate`: `extractLocalAssetPathCandidate(href)` 的结果，只在 `isLocal` 时存在，用于系统打开和显示文件夹。
- `isLocal`: 必须基于 `isLocalAssetUrl` / `isLocalAssetSource`，不能只看 `file:`。

## 8. File Type Detection

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
- 类型判断应优先基于 `localPathCandidate || href` 的去 query/hash 版本；不要直接对 `resolvedUrl` 判断，因为 Tauri asset URL 可能改变原始扩展名附近的字符串形态。
- 禁止 `javascript:`，未知协议不进入预览 pane。

## 9. Preview Pane Design

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

动作使用路径：

- 复制：优先复制 `localPathCandidate || href`，不要复制 `resolvedUrl`，否则用户会拿到 Tauri 内部 asset URL。
- 系统打开：本地文件传 `localPathCandidate || href`；远程网页传 `href`。
- 显示文件夹：只允许本地文件，传 `localPathCandidate || href` 给 `file:show-in-folder`。
- 预览渲染：只使用 `resolvedUrl`。

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

## 10. Layout Implementation

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

## 11. File-Level Implementation Plan

### 11.1 `MessageItem.tsx`

新增 props：

```ts
interface MessageItemProps {
  ...
  linkRenderMode?: 'default' | 'preview-card';
  onPreviewLink?: (target: ChatMessageLinkTarget) => void;
}
```

新增 helpers：

- `inferLinkKind(href: string): ChatMessageLinkKind`
- `labelFromLink(href: string, children: React.ReactNode): string`
- `buildMessageLinkTarget(href, children, msg.id): ChatMessageLinkTarget | null`
- `isPreviewableLinkProtocol(href: string): boolean`
- `stripUrlSearchAndHash(value: string): string`

修改 Markdown `a` renderer：

- 默认模式保持现有 `<a>`。
- `preview-card` 模式下：
  - 阻止默认跳转。
  - 构建 `ChatMessageLinkTarget`。
  - 调用 `onPreviewLink(target)`。
  - 如果 target 无效，回退为普通链接或禁用按钮。
  - 渲染为 `RedClaw` 附件风格 file card，而不是 inline text button。

关键约束：

- 不解析整段消息文本。
- 不新增 `useEffect` 扫描 DOM。
- 不把 URL 正则塞进 RedClaw 页面。
- 不改变 `img` Markdown 的现有渲染行为；图片 Markdown 仍可直接显示，链接按钮主要处理普通 links。
- 本地路径判断必须先走 `isLocalAssetSource` / `extractLocalAssetPathCandidate`，再判断协议；这是 Windows drive path 支持的关键。
- `isPreviewableLinkProtocol` 必须明确允许 Windows drive path 和 UNC path，不能用单纯 `^[a-z]+:` 判定。

### 11.2 `Chat.tsx`

新增 props：

```ts
messageLinkRenderMode?: 'default' | 'preview-card';
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

### 11.3 `RedClaw.tsx`

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
  messageLinkRenderMode="preview-card"
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

- `handleOpenPreviewExternal`: 本地文件调用 `window.ipcRenderer.openPath(target.localPathCandidate || target.href)`；远程链接调用 `window.ipcRenderer.openPath(target.href)`。
- `handleRevealPreviewInFolder`: 仅本地文件显示该动作，调用 `window.ipcRenderer.file.showInFolder({ source: target.localPathCandidate || target.href })`。
- `handleCopyPreviewTarget`: 可放在 pane 内直接用 `navigator.clipboard.writeText`。

关键约束：

- `previewTarget` 改变不能改变 `key={`redclaw:${chatRefreshKey}`}`，否则会重挂 Chat。
- 不能把右侧 pane 做成 fixed overlay；必须参与 RedClaw 内容区域布局。
- 不要让 preview pane 覆盖输入框。
- 不要把 `resolvedUrl` 传给 host open/reveal IPC。

### 11.4 `RedClawFilePreviewPane.tsx`

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
- 路径/URL 展示必须使用 `localPathCandidate || href`，避免展示 Tauri asset URL。

### 11.5 `pathManager.ts` / `localAsset.ts`

第一版优先不改这两个文件；实现应先复用现有能力。

只有在实际验证发现缺口时才允许小范围补 helper，并必须配套测试或至少补文档中对应的手测案例。任何新增 helper 都应保持通用、确定、无副作用，不能写成 RedClaw 专用分支。

## 12. Existing Libraries vs Self-Built Code

必须使用现成库/现有能力：

- Markdown parsing: `react-markdown` + `remark-gfm`。
- Local asset conversion: `resolveAssetUrl` + Tauri `convertFileSrc`。
- Local path classification: `desktop/shared/localAsset.ts` helpers。
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
- A thin target builder that combines existing local path helpers with kind inference.

不应自研：

- Markdown parser.
- URL autolink parser.
- Windows path parser that duplicates `desktop/shared/localAsset.ts`.
- Full PDF renderer.
- Video/audio decoder.
- Generic embedded browser.

## 13. Performance Strategy

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

## 14. Security And Safety

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
- Windows drive path、UNC path、legacy `local-file:`、`redbox-asset:` 都属于 local asset source，必须经 `extractLocalAssetPathCandidate` / `resolveAssetUrl` 处理。
- Tauri asset URL 只用于渲染，不用于复制、系统打开或显示文件夹。

外部网页规则：

- iframe 只用于用户点击后的显式预览。
- 系统打开按钮始终可用。
- 不把网页内容自动注入 AI 上下文。

## 15. Alternatives

| Option | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| A. 全局改 `MessageItem` 链接 | 所有 Chat 链接都变文件卡片 | 最快 | 影响主聊天、知识库、弹窗聊天，回归风险高 | 不推荐 |
| B. Fork RedClaw 消息组件 | RedClaw 自己维护一套消息 UI | 隔离强 | 复制消息、附件、workflow timeline、图片菜单逻辑，维护成本高 | 不推荐 |
| C. Chat 可选能力 + Chat 内部 inline side panel | 通用 Chat 透传事件并承载中间区域分栏，RedClaw 管 preview target | 改动小、边界清晰、不会和技能面板抢位置 | 需要设计 props contract | 推荐 |
| D. 直接用系统打开 | 点击后打开外部 app/browser | 实现最少 | 离开 RedClaw，无法边看边聊 | 不满足目标 |
| E. 右侧 fixed drawer overlay | 预览浮在聊天上方 | 快速 | 遮挡聊天，不符合“聊天区域左移” | 不推荐 |

推荐选项 C。

## 16. Implementation Sequence

本计划可以一个原子提交完成，提交主题建议：

```text
Add RedClaw inline file preview pane
```

执行顺序：

1. 在 `MessageItem.tsx` 增加 link target 类型、kind 推断和 preview-card renderer。
2. 先实现并本地检查 path target builder，覆盖 POSIX、Windows drive、UNC、file URL、redbox-asset、local-file、http(s) URL。
3. 在 `Chat.tsx` 增加 props，并用 `inlineSidePanel` 在聊天中间区域内部承载右侧预览。
4. 新增 `RedClawFilePreviewPane.tsx`，先实现 image/video/audio/pdf/web/unknown fallback。
5. 在 `RedClaw.tsx` 增加 `previewTarget` 状态，并把预览 pane 传给 `Chat.inlineSidePanel`，不要放到 RedClaw 外层侧栏层级。
6. 接入系统打开、复制、显示文件夹动作，确保本地动作使用 `localPathCandidate`。
7. 做样式收口：保证右栏宽度、Chat 宽度、输入框和消息都不重叠。
8. 验证普通 Chat 链接仍是普通外链。
9. 运行前端构建或类型检查。

## 17. Verification Plan

### 17.1 Manual UI Checks

在 RedClaw 会话里用 AI 或手动消息准备以下内容：

```md
[本地图片](/Users/Jam/.redbox/demo/image.png)
[本地视频](/Users/Jam/.redbox/demo/video.mp4)
[PDF 文档](/Users/Jam/.redbox/demo/report.pdf)
[Windows 图片](<file:///C:/Users/Jam/My Images/demo 1.png>)
[UNC 视频](<file://NAS/RedBox/assets/demo.mp4>)
[网页](https://example.com)
https://example.com/plain-url
```

检查：

- 链接在 AI 消息里显示为文件卡片，形态接近截图：左侧图标 tile，中间文件名/类型，右侧 `打开` 操作。
- 文件卡片是 block-level card，不是 inline pill；长文件名不会撑破消息容器。
- 点击图片后右侧显示图片。
- 点击视频后右侧显示视频播放器。
- 点击 PDF/网页后右侧显示 iframe 或 fallback。
- 连续点击不同链接时右侧内容更新。
- 关闭右侧 pane 后 Chat 恢复全宽。
- 输入框内容在打开/关闭预览时不丢失。
- Chat 滚动位置不因预览切换明显跳动。
- 技能面板打开时点击链接，技能面板收起，预览 pane 显示。

### 17.2 Path Compatibility Matrix

必须逐项验证 target 构建结果。即使当前开发机是 macOS，也要用单元级/console 级输入验证 Windows 字符串解析，不要求真实文件存在。

| Case | Input | Expected |
| --- | --- | --- |
| POSIX image | `/Users/Jam/.redbox/demo/image 1.png` | `isLocal=true`, `kind=image`, `localPathCandidate=/Users/Jam/.redbox/demo/image 1.png` |
| Windows drive image | `C:\Users\Jam\.redconvert\spaces\default\media\demo 1.png` | `isLocal=true`, `kind=image`, candidate keeps `C:/...` semantics |
| Windows slash path | `C:/Users/Jam/.redconvert/spaces/default/media/demo 1.png` | `isLocal=true`, `kind=image` |
| Windows file URL | `file:///C:/Users/Jam/My%20Images/demo%201.png` | `isLocal=true`, candidate decodes spaces once |
| Windows localhost file URL | `file://localhost/C:/Users/Jam/demo.pdf` | `isLocal=true`, `kind=pdf`, host ignored as localhost |
| UNC path | `\\NAS\RedBox\assets\demo.mp4` | `isLocal=true`, `kind=video`, UNC host/share preserved |
| UNC file URL | `file://NAS/RedBox/assets/demo.mp4` | `isLocal=true`, `kind=video`, candidate starts with `//NAS/RedBox` |
| RedBox asset URL | `redbox-asset://asset/C:/Users/Jam/demo.png` | `isLocal=true`, `kind=image`, preview uses `resolveAssetUrl` |
| Legacy local-file URL | `local-file:///C:/Users/Jam/demo.png` | `isLocal=true`, `kind=image` |
| Remote PDF with query | `https://example.com/report.pdf?token=abc#page=2` | `isLocal=false`, `kind=pdf` |
| Remote webpage | `https://example.com/articles/123` | `isLocal=false`, `kind=web` |
| Unsafe protocol | `javascript:alert(1)` | no target / no preview card |

### 17.3 Windows Support Checks

Windows 支持不能只靠“代码看起来用了 `replace('\\', '/')`”。需要明确检查：

- `C:\...` 不被 protocol regex 拦截。
- `file:///C:/...` 不变成 `/C:/...` 传给系统打开。
- `file://NAS/share/...` 不丢 `NAS`。
- `%20` 不重复编码。
- `app:open-path` 收到的是本地候选路径或原始 remote URL，不是 Tauri asset URL。
- `file:show-in-folder` 只在 `isLocal` 时显示，并收到本地候选路径。

### 17.4 Regression Checks

- 普通 `Chat` 页面链接仍显示为普通 `<a>`。
- `KnowledgeChatModal` 复用 Chat 时不出现 RedClaw file link cards。
- AI 消息里的图片 Markdown 仍能内联显示。
- 用户消息中的链接不被 RedClaw 强制变成预览卡片，除非后续明确需要。

### 17.5 Commands

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

## 18. Future Extensions

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

## 19. Acceptance Criteria

实现完成后必须满足：

- RedClaw AI 消息链接卡片化，并能打开右侧预览。
- 右侧预览是页面内分栏，不是覆盖层。
- Chat 不重挂、不清空、不丢输入。
- 普通 Chat 页面不受影响。
- 本地媒体和网页都有明确预览或恢复路径。
- 路径解析覆盖 POSIX、Windows drive、UNC、file URL、redbox-asset URL、legacy local-file URL 和 remote URL。
- Windows 字符串测试证明 `C:\...` 不被当成协议、UNC host 不丢失、空格不重复编码。
- 没有新增不必要的 runtime/tool/IPC surface。
- 改动保持在一个原子提交内。
