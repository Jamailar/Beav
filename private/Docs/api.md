# RedboxWeb 接口文档（中文）

更新时间：2026-03-24  
适用项目：`RedboxWeb`（租户 slug=`redbox`）

## 1. 基础约定

### 1.1 网关与租户
- 网关基地址：`VITE_GATEWAY_BASE_URL`，默认 `http://localhost:3000`
- 租户：`VITE_APP_SLUG`，默认 `redbox`
- RedboxWeb 当前默认使用租户路径：`/{app}/v1/...`

示例（默认配置）：
- `http://localhost:3000/redbox/v1/auth/login/sms`

### 1.2 鉴权方式
- 控制台业务接口（auth/users/payments）：`Authorization: Bearer <access_token>`
- OpenAI 兼容接口：`Authorization: Bearer <rbx_api_key>`（推荐）或 JWT

### 1.3 响应格式
- 业务接口可能返回直接 JSON，或 `{ data: ... }` 包裹形式，前端都已兼容
- OpenAI 兼容接口错误为 OpenAI 风格：
```json
{
  "error": {
    "message": "Authentication required",
    "type": "authentication_error",
    "param": null,
    "code": null
  }
}
```

## 2. 认证接口（注册/登录/微信）

前缀：`/{app}/v1/auth`

### 2.1 发送短信验证码
- `POST /auth/send-sms-code`
- 请求：
```json
{
  "phone": "13800138000"
}
```

### 2.2 手机号登录
- `POST /auth/login/sms`
- 请求：
```json
{
  "phone": "13800138000",
  "code": "123456",
  "invite_code": "AB12C"
}
```
- 返回：`access_token`、`refresh_token`、`user` 等

### 2.3 手机号注册（兼容别名）
- `POST /auth/register/sms`
- 行为与短信登录一致：首次建号，后续即登录

### 2.4 获取微信扫码登录信息
- `GET /auth/login/wechat/url?state=redbox-web`
- 返回关键字段：
  - `enabled`
  - `session_id`
  - `qr_content_url`
  - `url`
  - `expires_in`

### 2.5 轮询微信扫码状态
- `GET /auth/login/wechat/status?session_id=<session_id>`
- 状态：`PENDING | SCANNED | CONFIRMED | EXPIRED | FAILED`
- `CONFIRMED` 时会返回 `auth_payload`（含 token）

### 2.6 微信 code 登录（回调后换取登录态）
- `POST /auth/login/wechat`
- 请求：
```json
{
  "code": "wechat_oauth_code"
}
```

说明：
- 微信开放平台回调到你的 `redirect_uri` 页面后，前端拿到 `code`，再调用此接口完成登录。

## 3. 用户与 API Key 接口

前缀：`/{app}/v1/users`

### 3.1 获取当前用户
- `GET /users/me`

### 3.2 获取积分余额与计费规则
- `GET /users/me/points`

### 3.3 列出我的 API Keys
- `GET /users/me/api-keys`

### 3.4 创建 API Key
- `POST /users/me/api-keys`
- 请求：
```json
{
  "name": "Production Key"
}
```
- 返回中 `key` 明文只会出现一次

### 3.5 撤销 API Key
- `POST /users/me/api-keys/:key_id/revoke`

## 4. 支付与充值接口

前缀：`/{app}/v1/payments`

### 4.1 获取可购买商品
- `GET /payments/products`
- 关键字段：
  - `amount`：商品金额
  - `points_topup`：支付成功后自动充值的积分

### 4.2 创建支付宝 page-pay 订单
- `POST /payments/orders/page-pay`
- 请求：
```json
{
  "product_id": "uuid",
  "subject": "30元积分包",
  "points_to_deduct": 0
}
```
- 返回关键字段：
  - `out_trade_no`
  - `payment_form`（可能是 HTML form 或 URL）
  - `amount`、`original_amount`、`payable_amount`

### 4.3 创建微信 Native 支付订单（可选）
- `POST /payments/orders/wechat/native`
- 请求：
```json
{
  "product_id": "uuid",
  "description": "30元积分包"
}
```

### 4.4 查询订单状态
- `GET /payments/orders/:out_trade_no`
- 返回关键字段：
  - `status`
  - `trade_status`
  - `paid_at`
  - `points_topup_points`
  - `points_topup_status`（`NONE | PROCESSING | SUCCESS`）

### 4.5 支付回调接口（服务端/支付渠道调用，前端一般不直接调用）
- 支付宝异步通知：`POST /payments/callbacks/trade-notify`
- 支付宝同步回跳：`GET /payments/callbacks/trade-return`
- 支付宝签约回调：`POST /payments/callbacks/agreement-notify`
- 微信支付回调：`POST /payments/callbacks/wechat-notify`

## 5. OpenAI 兼容接口（调用 AI）

前缀可选：
- `/v1/...`（推荐给 API Key 调用）
- `/{app}/v1/...`
- `/api/v1/...`

支持能力：
- 语言模型：`POST /chat/completions`、`POST /completions`、`POST /responses`
- 模型列表：`GET /models`、`GET /models/:model`
- 嵌入模型：`POST /embeddings`
- 音频生成（TTS）：`POST /audio/speech`
- 转录/翻译（STT）：`POST /audio/transcriptions`、`POST /audio/translations`
- 图片生成：`POST /images/generations`

### 5.1 拉取所有可用模型
- `GET /v1/models`
- 示例：
```bash
curl -X GET "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $RBX_API_KEY"
```

### 5.2 拉取单个模型详情
- `GET /v1/models/{model}`

### 5.3 Chat Completions 示例
```bash
curl -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $RBX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

### 5.4 Embeddings 示例
```bash
curl -X POST "$BASE_URL/v1/embeddings" \
  -H "Authorization: Bearer $RBX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "hello world"
  }'
```

### 5.5 音频转录示例（JSON base64）
```bash
curl -X POST "$BASE_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $RBX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "whisper-1",
    "file_base64": "<base64>",
    "file_name": "demo.wav",
    "file_mime_type": "audio/wav"
  }'
```

### 5.6 音频生成示例（TTS）
```bash
curl -X POST "$BASE_URL/v1/audio/speech" \
  -H "Authorization: Bearer $RBX_API_KEY" \
  -H "Content-Type: application/json" \
  --output speech.mp3 \
  -d '{
    "model": "speech-2.8-hd",
    "input": "第一段内容<#0.6#>第二段内容(laughs)。",
    "voice": "male-qn-qingse",
    "speed": 1.05,
    "pitch": 0,
    "emotion": "happy",
    "response_format": "mp3",
    "return_audio_binary": true,
    "prefer_sync_tts": true,
    "audio_setting": {
      "sample_rate": 32000,
      "bitrate": 128000,
      "channel": 1
    }
  }'
```

支持要点：
- `input` / `text` 支持 MiniMax 停顿 `<#0.6#>` 和语气标签 `(laughs)`、`(sighs)` 等。
- `speed` / `voice_setting.speed`：`0.5 - 2.0`，默认 `1.0`。
- `pitch` / `voice_setting.pitch`：`-12 - 12`，默认 `0`。
- `emotion` / `voice_setting.emotion`：`happy`、`sad`、`angry`、`fearful`、`disgusted`、`surprised`、`calm`、`fluent`、`whipser`；也接受 `whisper`。
- `add_silence` / `voice_setting.add_silence` 按 MiniMax 原生参数透传。
- `sample_rate`、`bitrate`、`channel` 可放顶层，也可放在 `audio_setting` 内。
- `prefer_sync_tts` / `prefer_async_tts` / `async_tts` 控制同步或异步合成偏好。
- 长语音多段语气可传 `segments`。每段支持独立 `input`、`speed`、`pitch`、`emotion`、`add_silence`、`voice_setting`；媒体队列会逐段合成并合并成一个最终音频文件。

### 5.7 图片生成示例
```bash
curl -X POST "$BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $RBX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "A red robot in watercolor style",
    "size": "1024x1024"
  }'
```

## 6. RedboxWeb 当前实际使用到的接口

### 6.1 登录/注册页
- `POST /auth/send-sms-code`
- `POST /auth/login/sms`
- `POST /auth/register/sms`
- `GET /auth/login/wechat/url`
- `GET /auth/login/wechat/status`
- `POST /auth/login/wechat`

### 6.2 控制台概览 / Keys
- `GET /users/me/api-keys`
- `POST /users/me/api-keys`
- `POST /users/me/api-keys/:key_id/revoke`

### 6.3 控制台 Billing
- `GET /payments/products`
- `POST /payments/orders/page-pay`
- `GET /payments/orders/:out_trade_no`

## 7. 推荐联调流程

1. 在 appadmin 确认已创建应用 `slug=redbox`  
2. 调 `POST /auth/send-sms-code` + `POST /auth/login/sms` 拿 JWT  
3. 调 `POST /users/me/api-keys` 创建 `rbx_` Key  
4. 调 `GET /payments/products`、`POST /payments/orders/page-pay`、`GET /payments/orders/:out_trade_no` 跑充值  
5. 用 `rbx_` Key 调 `GET /v1/models`、`POST /v1/chat/completions` 验证 AI 链路
