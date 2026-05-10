---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-10
owner: redbox-platform
scope: desktop
target_files:
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/pages/Subjects.tsx
  - desktop/src/pages/MediaLibrary.tsx
  - desktop/src/pages/Settings.tsx
  - desktop/src/components/manuscripts/AudioDraftWorkbench.tsx
  - desktop/src/components/manuscripts/VideoDraftWorkbench.tsx
  - desktop/src-tauri/src/commands/mod.rs
  - desktop/src-tauri/src/commands/voice.rs
  - desktop/src-tauri/src/voice_service.rs
  - desktop/src-tauri/src/media_runtime/*
  - desktop/src-tauri/src/persistence/mod.rs
  - desktop/src-tauri/src/tools/*
success_metrics:
  - 资产库人物上传音频样本后自动提交声音复刻任务
  - 复刻成功后人物资产 metadata 稳定记录平台 voice_id
  - 稿件和视频生成 TTS 时只消费 voice_id，不理解 MiniMax 或 provider 原始 voice id
  - AI runtime 通过收敛的 voice tool 调用复刻和 TTS，不新增业务型顶层工具
  - TTS 输出作为普通音频资产进入媒体库，并能插入音频稿件或视频时间线
  - 声音复刻、TTS、音频转码和远端同步均不阻塞 UI 或持有全局 store 锁
---

# Voice Service、资产库音色绑定与 TTS 接入计划

## 1. 结论

声音复刻不应该做成独立页面，也不应该只是 Settings 里的附属功能。

推荐架构是把声音复刻和 TTS 收成桌面端底层 `Voice Service`：

1. 资产库人物 / 角色上传音频样本时，自动调用 `voice.clone`。
2. 后端返回的平台 `voice_id` 写回人物资产 metadata。
3. 稿件、视频编辑、RedClaw 和 AI runtime 只消费这个 `voice_id`。
4. TTS 生成结果保存为普通音频资产，再由稿件 / 时间线引用。
5. Settings 只保留同步、诊断和全局默认配置，不作为主使用入口。

这条路径能让“角色声音”成为资产库的一部分，而不是散落在一次性 TTS 表单里。

## 2. Product Position

RedConvert 的内容链路应保持以下职责：

```text
资产库            保存人物、角色、样本音频、voice_id 绑定
Voice Service    复刻、查询、删除音色，生成 TTS 音频
Media Library    保存样本音频和生成后的语音资产
Manuscripts      消费 voice_id 生成口播、旁白、音频稿件
Video Editor     消费生成音频并插入音频轨
RedClaw          自动编排角色口播、旁白生成、视频配音任务
Settings         账号、默认模型、诊断、远端音色同步
```

用户心智：

- “这个人物有自己的声音。”
- “给这个角色上传一段样本，以后就能用它说话。”
- “用这个角色声音读这段稿。”
- “做一条这个角色出镜 / 口播的视频。”

系统心智：

- 资产拥有声音绑定。
- Voice Service 负责远端 API 和本地文件落盘。
- Media Library 负责资产化结果。
- Manuscripts / Video Editor / RedClaw 只消费能力。

## 3. Backend Contract

现有服务器后端提供两个主流程：

### 3.1 声音复刻

```http
POST /{app}/v1/audio/voices/clone
Authorization: Bearer <app_api_key>
Content-Type: multipart/form-data
```

字段：

```text
file: 音频文件，必填，推荐 mp3/wav/m4a
name: 音色名，可选
language: 语言，可选，例如 zh / en / nl
model: 复刻模型 key，可选
```

返回：

```json
{
  "voice_id": "voice_xxxxxxxxxxxxxxxxxxxxxxxx",
  "name": "我的声音",
  "language": "zh",
  "status": "ready",
  "created_at": "..."
}
```

也支持受管 OSS 样本：

```json
{
  "sample_file_key": "ai/voice-samples/...",
  "name": "我的声音",
  "language": "zh",
  "model": "minimax-voice-clone"
}
```

桌面端第一版不直接传外部 URL。样本必须来自用户本地选择文件、Media Library 受管文件，或后端明确可识别的受管 OSS key。

### 3.2 音色管理

```http
GET /{app}/v1/audio/voices
GET /{app}/v1/audio/voices/{voice_id}
DELETE /{app}/v1/audio/voices/{voice_id}
```

列表用于同步和诊断，不作为资产库绑定的唯一 source of truth。人物资产 metadata 里的 `voiceId` 是本地创作链路的稳定引用。

### 3.3 TTS

```http
POST /{app}/v1/audio/speech
Authorization: Bearer <app_api_key>
Content-Type: application/json
```

推荐 payload：

```json
{
  "model": "speech-2.8-turbo",
  "input": "你好，这是复刻后的声音。",
  "voice_id": "voice_xxxxxxxxxxxxxxxxxxxxxxxx",
  "language_boost": "Chinese",
  "response_format": "mp3",
  "return_audio_binary": true
}
```

兼容 OpenAI 风格：

```json
{
  "model": "speech-2.8-turbo",
  "input": "Hello",
  "voice": "voice_xxx"
}
```

桌面端统一使用 `voice_id` 字段。底层服务可以兼容 `voice`，但不要在 UI 和 AI tool contract 里暴露两套命名。

## 4. Architecture

```text
Renderer UI
  Subjects.tsx / MediaLibrary.tsx / Manuscript Workbench / Video Workbench / Settings
        |
        v
desktop/src/bridge/ipcRenderer.ts
        |
        v
Tauri IPC
  voice:clone
  voice:list
  voice:get
  voice:delete
  voice:speech
  assets:bind-voice
        |
        v
desktop/src-tauri/src/commands/voice.rs
        |
        v
desktop/src-tauri/src/voice_service.rs
        |
        +--> official auth / OpenAI-compatible credentials
        +--> backend /audio/voices/* and /audio/speech
        +--> media asset store
        +--> asset metadata patch
        +--> background job events
```

### 4.1 New Host Modules

新增：

```text
desktop/src-tauri/src/voice_service.rs
desktop/src-tauri/src/commands/voice.rs
```

`voice_service.rs` 负责：

- 解析当前 app backend base URL 和 API key。
- 构造 clone multipart 请求。
- 调用 voice list / get / delete。
- 调用 speech，接收二进制音频。
- 把 TTS 输出写入 workspace media。
- 归一化错误码和可展示错误。
- 避免把 provider 原始字段泄漏到上层。

`commands/voice.rs` 负责：

- IPC channel dispatch。
- payload schema 校验。
- 调用 service。
- 返回 stable JSON。

`main.rs` 只注册路由，不新增业务逻辑。

### 4.2 Existing Modules To Reuse

复用：

- `desktop/src-tauri/src/http_utils.rs`：请求鉴权、错误脱敏、official reauth retry。
- `desktop/src-tauri/src/official_support.rs`：官方账号 session / API key 同步。
- `desktop/src-tauri/src/media_runtime/*`：后台 job、进度事件、重试和取消。
- `desktop/src-tauri/src/persistence/mod.rs`：本地状态与 workspace metadata 写回。
- `desktop/src/bridge/ipcRenderer.ts`：renderer 不直接调用 Tauri 原语。
- `desktop/src/components/manuscripts/*`：音频稿件和视频时间线插入。
- `desktop/src/vendor/freecut/*`：音频轨道、剪辑、链接媒体行为。

## 5. Data Model

## 5.1 Voice Profile

后端音色在桌面端归一化为：

```ts
type VoiceProfile = {
  voiceId: string;
  name: string;
  language?: string;
  status: 'ready' | 'processing' | 'failed' | string;
  cloneModel?: string;
  provider?: 'official' | 'custom';
  createdAt?: string;
  updatedAt?: string;
  remoteRaw?: unknown;
};
```

`remoteRaw` 只用于诊断，不进入 AI 上下文，不写进人物资产常规 metadata。

## 5.2 Asset Voice Binding

人物 / 角色资产 metadata 增加：

```ts
type AssetVoiceBinding = {
  voiceId?: string;
  name?: string;
  language?: string;
  status: 'none' | 'queued' | 'cloning' | 'ready' | 'failed' | 'deleted';
  cloneModel?: string;
  sampleAssetId?: string;
  sampleFilePath?: string;
  sampleHash?: string;
  jobId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSyncedAt?: string;
  lastError?: string;
};
```

人物资产示例：

```json
{
  "id": "asset_person_123",
  "kind": "person",
  "name": "主播 A",
  "voice": {
    "voiceId": "voice_xxx",
    "name": "主播 A",
    "language": "zh",
    "status": "ready",
    "sampleAssetId": "asset_audio_sample_456",
    "sampleHash": "sha256:...",
    "updatedAt": "2026-05-10T12:00:00Z"
  }
}
```

## 5.3 TTS Output Asset

TTS 生成结果作为普通音频资产：

```ts
type TtsAudioAssetMetadata = {
  kind: 'audio';
  source: 'tts';
  voiceId: string;
  sourceAssetId?: string;
  textHash: string;
  model: string;
  languageBoost?: string;
  responseFormat: 'mp3' | 'wav' | 'm4a';
  durationMs?: number;
  sampleRate?: number;
  createdAt: string;
};
```

文件落点建议：

```text
workspace/media/generated/tts/YYYY/MM/<asset-id>.mp3
workspace/media/generated/tts/YYYY/MM/<asset-id>.json
```

## 6. IPC Contract

Renderer 只调用 bridge：

```ts
window.ipcRenderer.voice.list()
window.ipcRenderer.voice.get({ voiceId })
window.ipcRenderer.voice.clone(payload)
window.ipcRenderer.voice.delete({ voiceId })
window.ipcRenderer.voice.speech(payload)
window.ipcRenderer.assets.bindVoice(payload)
```

### 6.1 `voice:clone`

Input：

```json
{
  "samplePath": "/absolute/or/workspace/path/sample.wav",
  "sampleAssetId": "asset_audio_sample_456",
  "name": "主播 A",
  "language": "zh",
  "model": "minimax-voice-clone",
  "owner": {
    "kind": "asset",
    "assetId": "asset_person_123"
  },
  "mode": "auto_if_missing"
}
```

Output：

```json
{
  "success": true,
  "jobId": "voice_clone_job_123",
  "status": "queued",
  "voice": null
}
```

如果同步完成得很快，也允许直接返回：

```json
{
  "success": true,
  "jobId": "voice_clone_job_123",
  "status": "ready",
  "voice": {
    "voiceId": "voice_xxx",
    "name": "主播 A",
    "language": "zh",
    "status": "ready"
  }
}
```

### 6.2 `voice:speech`

Input：

```json
{
  "input": "要朗读的文本",
  "voiceId": "voice_xxx",
  "sourceAssetId": "asset_person_123",
  "model": "speech-2.8-turbo",
  "languageBoost": "Chinese",
  "responseFormat": "mp3",
  "target": {
    "kind": "media_asset",
    "workspaceId": "default"
  }
}
```

Output：

```json
{
  "success": true,
  "asset": {
    "assetId": "asset_audio_tts_789",
    "kind": "audio",
    "path": "workspace/media/generated/tts/2026/05/asset_audio_tts_789.mp3",
    "voiceId": "voice_xxx",
    "durationMs": 3280
  }
}
```

## 7. Asset Library Flow

## 7.1 First Audio Upload For Person Asset

```text
用户打开人物资产详情
  -> 上传样本音频
  -> 保存音频为 Media asset
  -> patch person.voice = { status: "queued", sampleAssetId, sampleHash }
  -> 提交 voice clone job
  -> job running: status = "cloning"
  -> 后端返回 voice_id
  -> patch person.voice = { status: "ready", voiceId, ... }
  -> UI 显示试听 / 重新复刻 / 删除绑定
```

规则：

- 首次上传样本且人物没有 `voice.voiceId` 时，自动复刻。
- 如果人物已有 ready voice，上传更多音频只保存为素材，不自动替换 voice。
- 替换声音必须是显式动作：`重新复刻`。
- 复刻失败不删除样本音频，只把 `voice.status` 改为 `failed` 并记录 `lastError`。
- 删除远端 voice 时，本地人物绑定改为 `deleted` 或清空，不能留下可用态。

## 7.2 Retry And Replace

重试：

```text
failed -> 用户点重试 -> 使用同一个 sampleAssetId / sampleHash -> voice.clone
```

重新复刻：

```text
ready -> 用户点重新复刻 -> 选择样本 -> 新 job -> 成功后替换 voiceId
```

重新复刻成功前，旧 `voiceId` 仍保持可用。只有新 voice ready 后才切换绑定，避免中途失败导致人物无法发声。

## 7.3 Sync Remote Voices

Settings 里的“音色同步”做三件事：

1. 调 `GET /audio/voices` 拉远端列表。
2. 标记本地绑定是否仍存在远端 voice。
3. 给 orphan remote voice 提供诊断信息。

它不应该自动把远端所有 voice 塞回资产库人物。人物绑定必须来自用户资产或明确导入动作。

## 8. AI Tool Design

声音能力应作为底层 tool，而不是业务 agent。

推荐在现有工具体系里增加收敛 action，不新增一堆业务顶层工具。

### 8.1 Tool: `voice.clone`

Schema：

```json
{
  "type": "object",
  "required": ["samplePath"],
  "properties": {
    "samplePath": {
      "type": "string",
      "description": "受管本地音频样本路径或 workspace-relative path"
    },
    "sampleAssetId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "language": {
      "type": "string",
      "description": "语言代码，例如 zh, en, nl"
    },
    "ownerAssetId": {
      "type": "string",
      "description": "可选。需要写回 voiceId 的人物/角色资产 id"
    },
    "mode": {
      "type": "string",
      "enum": ["auto_if_missing", "force_replace", "retry"]
    }
  }
}
```

约束：

- 不接受任意外部 URL。
- `ownerAssetId` 必须是本地存在的人物 / 角色资产。
- `force_replace` 需要用户确认。
- 工具返回 structured result，不返回 provider 原始对象。

### 8.2 Tool: `voice.speech`

Schema：

```json
{
  "type": "object",
  "required": ["input", "voiceId"],
  "properties": {
    "input": {
      "type": "string"
    },
    "voiceId": {
      "type": "string",
      "pattern": "^voice_"
    },
    "sourceAssetId": {
      "type": "string"
    },
    "responseFormat": {
      "type": "string",
      "enum": ["mp3", "wav", "m4a"]
    },
    "target": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["media_asset", "manuscript_audio", "video_timeline"]
        },
        "projectPath": {
          "type": "string"
        }
      }
    }
  }
}
```

约束：

- AI 可以选择人物资产，但宿主层负责解析 `voiceId`。
- AI 不知道 MiniMax provider voice id。
- 输出先落为 media asset，再由另一个 action 插入稿件或时间线。
- 长文本由宿主层切段，不让 AI 自己拼接 ffmpeg 命令。

## 9. UI Plan

UI 加法保持克制，不新增解释型大页面。

## 9.1 Asset Library Person Detail

人物 / 角色详情加一个紧凑的声音区：

```text
声音
[上传样本]  [试听]  [重新复刻]  [删除]
状态：复刻中 / 已就绪 / 失败
```

交互：

- 无样本：只显示上传按钮。
- 已上传、复刻中：显示状态和取消 / 稍后刷新。
- ready：显示试听、重新复刻、删除。
- failed：显示失败状态和重试。

不在卡片列表里展示长说明。列表最多显示一个小型声音状态 icon。

## 9.2 Media Library

Media Library 对音频资产做两类区分：

- `sample_audio`：人物声音样本。
- `tts_output`：TTS 生成结果。

资产详情里展示：

- 关联人物。
- `voiceId`。
- 用途：样本 / TTS 输出。
- 试听。
- 显示文件位置。

## 9.3 Manuscript Workbench

稿件侧第一版只加一个自然动作：

```text
选中文本 -> 生成语音
```

弹层字段：

- 角色 / 音色选择。
- 输出格式。
- 生成按钮。

生成后：

- 保存到 Media Library。
- 对音频稿件，插入当前音频稿件轨道或附件位。
- 对普通稿件，插入一个可点击音频引用。

## 9.4 Video Workbench

视频侧消费 TTS 音频：

```text
选中文本 / 选中字幕段 / 选中脚本段 -> 使用角色声音生成旁白 -> 插入音频轨
```

第一版只做插入音频轨，不做自动口型、自动配字幕和复杂混音。

## 9.5 Settings

Settings -> AI 下只做：

- 当前语音后端连接状态。
- 默认 TTS 模型。
- 默认复刻模型。
- 远端音色同步。
- 诊断错误。

不要把 Settings 作为用户日常管理人物声音的主入口。

## 10. Video And Audio Processing

必须用现成库：

- `ffmpeg` / `ffprobe`：转码、时长探测、concat、响度分析、格式兼容。
- 前端 `<audio>`：试听。
- 现有 vendor/freecut 时间线：音频轨插入、裁剪、移动、同步。
- `cpal` + `hound`：本地录音和 wav 编码，当前已有基础。

需要自研：

- Voice Service contract。
- 声音绑定 metadata。
- 自动复刻触发规则。
- TTS 输出资产化。
- 长文本切段、重试和结果拼接 orchestration。
- AI tool schema 和宿主安全边界。

不要自研：

- 声音复刻模型。
- TTS 模型。
- 音频编解码器。
- 波形分析底层。
- 完整 DAW / NLE 混音系统。

## 11. Performance Strategy

### 11.1 Background Jobs

声音复刻和 TTS 都进入后台 job：

- UI 立即返回 `jobId`。
- 用事件更新状态。
- 支持失败重试。
- app 重启后能恢复未完成 job 或标记为待确认。

### 11.2 Locking

Rust 侧遵守固定模式：

```text
持锁读取最小快照
  -> 释放锁
  -> 上传 / 下载 / ffmpeg / 文件写入
  -> 重新持锁应用最终 patch
```

不允许在 `with_store_mut` 里做：

- HTTP 请求。
- multipart 上传。
- 二进制音频下载。
- ffmpeg / ffprobe。
- 目录扫描。
- 大文件写入。

### 11.3 File And Memory

- TTS 二进制响应直接写文件，不进入 React state。
- Renderer 只拿 asset metadata 和 playable URL。
- 长文本按段落或句群切分，每段单独生成。
- 拼接使用 ffmpeg concat。
- 对同一 `voiceId + model + inputHash + format` 可以做可选缓存。

### 11.4 Queue And Rate Limit

默认并发：

- voice clone：1 个并发。
- TTS：2 个并发。
- ffmpeg post-process：1-2 个并发，按已有 media runtime 限流。

失败策略：

- 401：尝试 official auth refresh。
- 429 / 5xx：指数退避重试。
- 4xx payload error：不自动重试，记录可读错误。
- 样本格式不支持：先尝试 ffmpeg 转为 wav 或 mp3，再复刻。

## 12. Security And Privacy

- API key 只在 host 层使用，renderer 不拼 Authorization header。
- 样本文件必须是用户选择或 workspace 受管文件。
- 不接受外部任意 URL 复刻。
- 日志中脱敏 API key、voice id 可保留但 provider raw id 不记录。
- 删除 voice 时提示会影响使用该音色的人物和历史 TTS 生成能力。
- 历史已经生成的音频文件不因远端 voice 删除而自动删除。
- AI tool 写回人物 voice binding 时必须经过 schema 校验和 owner asset 校验。

## 13. Phased Execution Plan

## Phase 0: Contract And Inventory

目标：先把协议和现有入口摸清楚，不动 UI。

任务：

1. 确认资产库人物 / 角色的当前数据结构和持久化文件。
2. 确认 Media Library 当前音频资产写入路径。
3. 确认 Settings official base URL / API key 的读取方式。
4. 定义 `VoiceProfile`、`AssetVoiceBinding`、`TtsAudioAssetMetadata`。
5. 明确 IPC channel 名称和 JSON schema。

产物：

- 新增 Rust type 或 TS type。
- 更新 `desktop/docs/contracts/shared-types.md` 或附近模块 README。
- 不修改可见 UI。

验证：

- `pnpm exec tsc --noEmit`
- `cargo check`

## Phase 1: Voice Service Host Layer

目标：底层服务可独立完成 list / clone / speech。

任务：

1. 新增 `voice_service.rs`。
2. 新增 `commands/voice.rs`。
3. 注册 IPC：
   - `voice:list`
   - `voice:get`
   - `voice:clone`
   - `voice:delete`
   - `voice:speech`
4. 复用 official auth 和 HTTP utils。
5. clone 支持 multipart local file。
6. speech 支持 binary response 写入临时文件或 media output dir。
7. 错误统一成 `{ code, message, retryable }`。

产物：

- 无 UI 调用也能用 IPC probe 测通。
- 真实后端 API 可返回 voice id 和音频文件。

验证：

- cargo unit tests 覆盖 URL normalization、payload validation、error mapping。
- 真实 clone 一个短样本，确认返回 `voice_id`。
- 真实 speech 一句短文本，确认 mp3 可播放。

## Phase 2: Media Asset Integration

目标：TTS 输出和样本音频都进入 Media Library 语义。

任务：

1. 定义 `sample_audio` 和 `tts_output` metadata。
2. 上传样本音频时保存为 media asset。
3. TTS 输出写入 `workspace/media/generated/tts/`。
4. ffprobe 探测 duration / format。
5. Media Library 能识别并预览这些音频资产。
6. 删除或移动资产时保持人物 voice binding 不被误删。

产物：

- 样本音频和生成语音都可在 Media Library 里试听。
- TTS output metadata 包含 `voiceId`、`sourceAssetId`、`textHash`。

验证：

- 上传 mp3 / wav / m4a 样本。
- 生成 mp3 TTS。
- 刷新页面后音频资产仍可见。
- 文件路径和 asset metadata 一致。

## Phase 3: Asset Library Auto Clone

目标：人物 / 角色资产上传音频后自动复刻并记录 `voiceId`。

任务：

1. 在人物资产详情增加样本音频上传入口。
2. 上传后写入 `voice.status = queued`。
3. 如果无 ready `voiceId`，自动调用 `voice:clone`。
4. job running 时写入 `cloning`。
5. 成功后写入 `ready + voiceId`。
6. 失败后写入 `failed + lastError`。
7. 支持重试。
8. 支持显式重新复刻。
9. 支持解除绑定。

关键规则：

- 首次上传自动复刻。
- 已有 ready voice 后，再上传音频不自动替换。
- 重新复刻成功前旧 voiceId 继续可用。
- 删除远端 voice 不删除历史 TTS 音频。

产物：

- 人物资产 metadata 稳定包含 voice binding。
- UI 能看到状态、试听、重试、重新复刻。

验证：

- 新人物上传样本，自动得到 voiceId。
- 已有人物上传第二段样本，不覆盖 voiceId。
- 复刻失败后可重试。
- 刷新 app 后状态保留。

## Phase 4: TTS Consumption In Manuscripts

目标：稿件能用人物声音生成语音资产。

任务：

1. 稿件编辑器支持选中文本生成语音。
2. 音色选择优先展示资产库人物。
3. 只展示 ready voice。
4. 调 `voice:speech`。
5. 生成结果进入 Media Library。
6. 音频稿件把结果插入当前稿件结构。
7. 普通稿件插入音频引用或附件 binding。

产物：

- 用户能从文本生成角色声音语音。
- 生成音频可以二次使用。

验证：

- 中文短句生成。
- 长文本切段或提示超长。
- 取消 / 失败不污染稿件。
- 刷新后音频引用仍可打开。

## Phase 5: TTS Consumption In Video Editor

目标：视频编辑器能把角色声音生成的音频插入时间线。

任务：

1. 脚本段 / 字幕段 / 文本选择触发 TTS。
2. 生成音频资产。
3. 通过现有 timeline capability 插入音频轨。
4. 默认插入当前 playhead 或选中片段起点。
5. 保留可撤销操作。

不做：

- 自动口型同步。
- 全自动混音。
- 多角色剧本分配。
- 复杂字幕对齐。

产物：

- 一段旁白可以从脚本生成并插入视频时间线。

验证：

- 生成后音频轨出现。
- 预览可播放。
- undo / redo 不破坏项目。
- 导出视频包含音频。

## Phase 6: AI Runtime Tooling

目标：RedClaw 和主 AI 可以用底层 voice 工具，而不是拼接口。

任务：

1. 在工具 catalog 中加入 `voice.clone` 和 `voice.speech`。
2. 工具 schema 使用严格 JSON。
3. 工具描述强调：
   - clone 只接受受管样本。
   - speech 输出先生成音频资产。
   - provider 和 MiniMax 细节不可见。
4. 增加 permission policy：
   - 自动 speech 可低风险。
   - `force_replace` voice binding 需要用户确认。
   - 删除 voice 需要用户确认。
5. RedClaw 任务中支持：
   - 选择人物。
   - 检查 voiceId。
   - 缺失时从已有样本自动复刻。
   - ready 后生成旁白。

产物：

- AI 可以稳定执行“用这个角色声音读这段稿”。
- 工具调用链可审计。

验证：

- 跑一轮真实 RedClaw 任务。
- 检查 transcript、tool result、asset metadata。
- 确认没有 provider raw voice id 泄漏进普通回复。

## Phase 7: Settings Diagnostics And Sync

目标：补齐管理和诊断，但不扩大日常 UI。

任务：

1. Settings -> AI 增加 Voice diagnostics 区。
2. 展示：
   - 后端连接状态。
   - 默认 clone model。
   - 默认 TTS model。
   - 远端 voices 数量。
   - 最近错误。
3. 支持手动同步远端 voices。
4. 标记本地绑定的 voice 是否远端仍存在。

产物：

- 用户能排查 API key、后端不可用、voice 不存在等问题。

验证：

- 未登录 / key 失效时有明确错误。
- 远端删除 voice 后，本地人物显示不可用状态。

## 14.方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. Settings 音色管理为主 | 用户先去 Settings 复刻，再手动选 voice | 实现直观 | 和人物资产割裂，RedClaw 难自动使用 | 不推荐 |
| B. 资产库人物拥有 voice binding | 上传人物样本自动复刻，voiceId 写入资产 | 符合创作心智，后续视频/稿件/AI 都能复用 | 需要补资产 metadata 和后台 job | 推荐 |
| C. 每次 TTS 临时复刻 | 生成语音前即时上传样本复刻 | 不需要管理音色 | 成本高、慢、不可复用、失败率高 | 不推荐 |
| D. 独立配音工作台 | 新页面集中管理复刻和 TTS | 功能看起来完整 | UI 变重，脱离资产库和创作链路 | 后续高级功能再考虑 |

最终选择 B。

## 15. Acceptance Checklist

- [ ] 人物资产上传音频样本会保存为受管音频资产。
- [ ] 新人物首次上传样本会自动提交 voice clone。
- [ ] clone 成功后人物 metadata 写入 `voice.voiceId`。
- [ ] 已有 ready voice 时，新上传样本不会自动覆盖旧 voice。
- [ ] 用户可以显式重新复刻，并且新 voice ready 前旧 voice 保持可用。
- [ ] TTS 只使用 `voiceId`，不暴露 provider 原始 voice id。
- [ ] TTS 输出保存为 media asset。
- [ ] 稿件能用人物 voice 生成语音。
- [ ] 视频编辑器能插入生成音频。
- [ ] RedClaw 能通过 voice tool 生成角色旁白。
- [ ] 所有 HTTP、ffmpeg、文件写入都在锁外执行。
- [ ] 刷新失败保留上一次成功的本地资产和绑定状态。

## 16. Atomic Commit Plan

严格保持一个提交只做一件事：

1. `docs: add voice service asset binding plan`
2. `voice: add service contracts and ipc shell`
3. `voice: implement backend voice clone and list`
4. `voice: implement tts output asset writing`
5. `assets: add person voice binding metadata`
6. `assets: auto clone voice from person audio sample`
7. `media: classify voice sample and tts audio assets`
8. `manuscripts: generate speech from bound asset voice`
9. `video: insert generated speech into audio track`
10. `runtime: expose voice clone and speech tools`
11. `settings: add voice diagnostics and remote sync`

不要把 UI、host service、AI tool 和视频时间线改动混进一个提交。
