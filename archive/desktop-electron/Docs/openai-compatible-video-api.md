# OpenAI 兼容视频生成扩展 API

最后更新：2026-04-03

## 1. 目标
- 对外继续使用统一入口：`/{slug}/v1/videos/generations`
- 基础字段尽量保持 OpenAI 风格：
  - `model`
  - `prompt`
  - `size`
  - `seconds`
- 为适配阿里云 DashScope 视频模型高级能力，增加少量扩展字段：
  - `video_mode`
  - `media[]`

该扩展当前主要服务于 DashScope 原生视频模型：
- `wan2.6-i2v*`
- `wan2.7-t2v`
- `wan2.7-r2v`
- `wan2.7-i2v`

---

## 2. 路由
统一入口：

```http
POST /{slug}/v1/videos/generations
```

异步入口：

```http
POST /{slug}/v1/videos/generations/async
POST /{slug}/v1/videos/generations/tasks/query
```

兼容入口：

```http
POST /api/v1/videos/generations
POST /v1/videos/generations
POST /api/v1/videos/generations/async
POST /v1/videos/generations/async
POST /api/v1/videos/generations/tasks/query
POST /v1/videos/generations/tasks/query
```

---

## 3. 通用请求格式

### 3.1 推荐格式

```json
{
  "model": "wan2.7-t2v",
  "prompt": "一只小黑猫好奇地仰望天空。",
  "size": "1280x720",
  "seconds": 10
}
```

### 3.2 通用字段
- `model`: 模型名，必填
- `prompt`: 提示词，可选
- `size`: OpenAI 风格尺寸，内部会映射到 DashScope `resolution`
- `resolution`: 也可直接传 `720P` / `1080P`
- `seconds`: OpenAI 风格秒数，内部会映射到 DashScope `duration`
- `duration`: 也可直接传 DashScope 原生秒数
- `negative_prompt`: 可选
- `watermark`: 可选
- `prompt_extend`: 可选
- `seed`: 可选

### 3.3 扩展字段
- `video_mode`: 三选一
  - `first_frame`
  - `first_last_frame`
  - `continuation`
- `media`: 媒体数组

每个 `media` 元素格式：

```json
{
  "type": "first_frame",
  "url": "https://example.com/asset.png"
}
```

支持的 `type`：
- `first_frame`
- `last_frame`
- `driving_audio`
- `first_clip`
- `reference_image`
- `reference_video`

每个 `media` 元素支持的媒体字段：
- `url`
- `uri`
- `file_url`
- `image_url`
- `audio_url`
- `video_url`
- `data`
- `b64_json`
- `base64`

说明：
- 若传 `data:` Data URL 或裸 Base64，服务端会自动转成 DashScope 可用的临时 URL
- 推荐优先使用 `url`

---

## 4. 三类模型

### 4.1 文生视频
适用：
- `wan2.7-t2v`

推荐请求：

```json
{
  "model": "wan2.7-t2v",
  "prompt": "一只戴着墨镜的狗在街道上滑滑板，3D 卡通。",
  "size": "1280x720",
  "seconds": 10,
  "audio_url": "https://example.com/voice.mp3"
}
```

规则：
- 必须有 `prompt`
- 不需要 `media[]`
- 可选 `audio_url`
- `size` 会映射成 `resolution + ratio`

---

### 4.2 参考生视频
适用：
- `wan2.7-r2v`

推荐请求：

```json
{
  "model": "wan2.7-r2v",
  "prompt": "图片 1 抱着图片 2 在咖啡厅里对镜头微笑。",
  "size": "1280x720",
  "seconds": 10,
  "media": [
    {
      "type": "reference_image",
      "url": "https://example.com/role-1.png"
    },
    {
      "type": "reference_image",
      "url": "https://example.com/role-2.png"
    }
  ]
}
```

规则：
- 必须至少有一个 `reference_image` 或 `reference_video`
- 可额外附带一个 `first_frame`
- 可选 `reference_voice`

兼容别名：
- `reference_images[]` / `reference_image_urls[]` -> `reference_image`
- `reference_videos[]` / `reference_video_urls[]` -> `reference_video`
- `reference_image` / `reference_image_url` -> `reference_image`
- `reference_video` / `reference_video_url` -> `reference_video`
- `first_frame_url` / `first_frame` -> `first_frame`

---

### 4.3 图生视频
适用：
- `wan2.7-i2v`
- `wan2.6-i2v*`

#### 4.3.1 首帧生视频

推荐请求：

```json
{
  "model": "wan2.7-i2v",
  "prompt": "一幅都市奇幻艺术场景。",
  "size": "1280x720",
  "seconds": 10,
  "video_mode": "first_frame",
  "media": [
    {
      "type": "first_frame",
      "url": "https://example.com/first-frame.png"
    },
    {
      "type": "driving_audio",
      "url": "https://example.com/drive.mp3"
    }
  ]
}
```

规则：
- 必须有 `first_frame`
- 可选 `driving_audio`
- 不允许 `last_frame`
- 不允许 `first_clip`

兼容别名：
- `image` / `image_url` / `reference_image` / `img_url` -> `first_frame`
- `audio_url` / `driving_audio_url` -> `driving_audio`

---

#### 4.3.2 首尾帧生视频
仅适用：
- `wan2.7-i2v`

推荐请求：

```json
{
  "model": "wan2.7-i2v",
  "prompt": "写实风格，一只小黑猫从平视逐渐过渡到俯视镜头。",
  "resolution": "720P",
  "duration": 10,
  "video_mode": "first_last_frame",
  "media": [
    {
      "type": "first_frame",
      "url": "https://example.com/first.png"
    },
    {
      "type": "last_frame",
      "url": "https://example.com/last.png"
    }
  ]
}
```

规则：
- 必须有 `first_frame`
- 必须有 `last_frame`
- 可选 `driving_audio`
- 不允许 `first_clip`

兼容别名：
- `image` / `image_url` -> `first_frame`
- `last_frame_url` / `last_frame` / `last_image_url` -> `last_frame`

---

#### 4.3.3 视频续写
仅适用：
- `wan2.7-i2v`

推荐请求：

```json
{
  "model": "wan2.7-i2v",
  "prompt": "一只戴着墨镜的狗在街道上滑滑板，3D 卡通。",
  "size": "1280x720",
  "seconds": 10,
  "video_mode": "continuation",
  "media": [
    {
      "type": "first_clip",
      "url": "https://example.com/clip.mp4"
    }
  ]
}
```

规则：
- 必须有 `first_clip`
- 可选 `last_frame`
- 不允许 `first_frame`
- 不允许 `driving_audio`

兼容别名：
- `first_clip_url`
- `video_url`
- `video`

---

## 5. 服务端映射规则

### 5.1 DashScope `wan2.7-t2v`
服务端会映射为：

```json
{
  "model": "wan2.7-t2v",
  "input": {
    "prompt": "..."
  },
  "parameters": {
    "resolution": "720P",
    "ratio": "16:9",
    "duration": 10
  }
}
```

### 5.2 DashScope `wan2.7-r2v`
服务端会映射为：

```json
{
  "model": "wan2.7-r2v",
  "input": {
    "prompt": "...",
    "media": [
      { "type": "reference_image", "url": "..." }
    ]
  },
  "parameters": {
    "resolution": "720P",
    "ratio": "16:9",
    "duration": 10
  }
}
```

### 5.3 DashScope `wan2.7-i2v`
服务端会映射为：

```json
{
  "model": "wan2.7-i2v",
  "input": {
    "prompt": "...",
    "media": [
      { "type": "first_frame", "url": "..." },
      { "type": "last_frame", "url": "..." }
    ]
  },
  "parameters": {
    "resolution": "720P",
    "duration": 10
  }
}
```

### 5.4 DashScope `wan2.6-i2v*`
`wan2.6` 仍走阿里原生旧结构：

```json
{
  "model": "wan2.6-i2v-flash",
  "input": {
    "prompt": "...",
    "img_url": "...",
    "audio_url": "..."
  },
  "parameters": {
    "resolution": "720P",
    "duration": 10
  }
}
```

说明：
- `wan2.6` 不支持本页定义的三种高级模式全量能力
- `first_last_frame`
- `continuation`
  这两种模式本质上是 `wan2.7-i2v` 的增强能力

---

## 6. 返回格式
服务端会等待 DashScope 异步任务完成后再返回，不把 `task_id` 查询责任丢给客户端。

返回示例：

```json
{
  "created": 1775000000,
  "task_id": "0385dc79-5ff8-4d82-bcb6-xxxxxx",
  "video_url": "https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/xxx.mp4?Expires=xxx",
  "data": [
    {
      "url": "https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/xxx.mp4?Expires=xxx",
      "mime_type": "video/mp4"
    }
  ]
}
```

### 6.1 异步创建
适用：
- DashScope 原生视频模型

请求：

```http
POST /{slug}/v1/videos/generations/async
```

请求体与同步接口一致。

返回示例：

```json
{
  "created": 1775000000,
  "task_id": "0385dc79-5ff8-4d82-bcb6-xxxxxx",
  "task_status": "PENDING",
  "request_id": "4909100c-7b5a-9f92-bfe5-xxxxxx"
}
```

### 6.2 异步查询
请求：

```http
POST /{slug}/v1/videos/generations/tasks/query
Content-Type: application/json
```

请求体：

```json
{
  "model": "wan2.7-t2v",
  "task_id": "0385dc79-5ff8-4d82-bcb6-xxxxxx"
}
```

说明：
- `task_id` 必填
- `model` 强烈建议传，便于服务端定位正确视频源和能力路由

查询成功返回示例：

```json
{
  "created": 1775000100,
  "task_id": "0385dc79-5ff8-4d82-bcb6-xxxxxx",
  "task_status": "SUCCEEDED",
  "request_id": "4909100c-7b5a-9f92-bfe5-xxxxxx",
  "video_url": "https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/xxx.mp4?Expires=xxx",
  "data": [
    {
      "url": "https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/xxx.mp4?Expires=xxx",
      "mime_type": "video/mp4"
    }
  ],
  "usage": {
    "duration": 10,
    "resolution": "720P"
  }
}
```

---

## 7. 超出 OpenAI 官方标准的部分
以下字段不是 OpenAI 官方标准字段，是本项目为兼容 DashScope 视频高级能力提供的扩展：
- `video_mode`
- `media[]`
- `last_frame_url`
- `first_clip_url`
- `driving_audio_url`
- `reference_images`
- `reference_videos`
- `reference_voice`

如果调用方只使用 OpenAI 常规字段，则只能稳定覆盖最基础的视频生成场景；无法完整表达：
- 首尾帧生视频
- 视频续写
- 驱动音频
- 参考素材生视频

---

## 8. 建议
- 新接入方统一使用本文档的 `video_mode + media[]` 推荐格式
- 历史调用方可以继续使用旧别名，服务端仍兼容
- 若是 DashScope `wan2.7-i2v`，优先使用：
  - `video_mode`
  - `media[]`
  而不是多个分散别名
