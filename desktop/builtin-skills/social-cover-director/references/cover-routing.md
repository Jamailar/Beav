# Cover Routing

Use this reference to route platform, surface, aspect ratio, and variant count.

## Count Rule

The user can choose the count. If not specified:

| Cover task | Default | Practical range |
|---|---:|---|
| single social cover | 1 | 1 |
| cover variants | 3 | 2-4 |
| A/B test pool | 4 | 3-6 |
| short-video frame variants | 3 | 2-4 |
| Pinterest pin variants | 3 | 2-5 |

Do not make a carousel plan here. If the user asks for a full swipe set, use `image-director`.

## China Platform Defaults

| Platform / surface | Cover type | Aspect ratio | Notes |
|---|---|---|---|
| 小红书笔记封面 | `note_cover` | `3:4` or `4:5` | saveable title, refined lifestyle/detail, strong headline |
| 小红书视频封面 | `short_video_cover` | `3:4` or `9:16` | thumbnail logic; face/action/result works well |
| 抖音图文首图 | `note_cover` | `3:4` or `4:5` | faster hook, higher contrast, result early |
| 抖音/快手短视频封面 | `short_video_cover` | `9:16` | first-glance action, face, conflict, or result |
| 微信朋友圈 | `community_post_cover` | `1:1` or `4:5` | trust, relationship, mature clean visual |
| 视频号图片/视频封面 | `short_video_cover` | `9:16` or `4:5` | behaves like video cover; concise copy |
| 微博图文 | `community_post_cover` | `1:1` or `4:5` | public topic, event, hot-take headline |
| B站动态/视频封面 | `community_post_cover` | `16:9` or `4:5` | review/explainer promise, expressive thumbnail |
| 公众号文章封面 | `article_cover` | `16:9` or `4:3` | article promise and brand tone over feed chaos |

## Overseas Platform Defaults

| Platform / surface | Cover type | Aspect ratio | Notes |
|---|---|---|---|
| Instagram feed cover | `note_cover` | `4:5` | polished social identity, lifestyle/creator proof |
| Instagram Reels cover | `short_video_cover` | `9:16` | thumbnail frame with clear subject and title zone |
| TikTok Photo Mode cover | `note_cover` | `9:16` or `4:5` | creator-native, raw proof, high energy |
| TikTok/Reels/Shorts cover | `short_video_cover` | `9:16` | face/action/conflict/result |
| Pinterest standard pin | `pin_cover` | `2:3` | saveable idea, search intent, moodboard clarity |
| Facebook/Meta post/ad cover | `ad_cover` | `4:5` or `1:1` | direct response or clear social proof |
| YouTube Shorts cover | `short_video_cover` | `9:16` | selected frame logic |
| YouTube thumbnail-like cover | `short_video_cover` | `16:9` | bold face/action/conflict/title |
| Snapchat single image/video | `short_video_cover` | `9:16` | playful urgency and simple hook |

## Reference Role Route

| Reference role | Meaning | Prompt treatment |
|---|---|---|
| `subject_identity` | person, product, place, outfit, object must stay recognizable | preserve identity, shape, color, key features |
| `style_reference` | learn mood, typography, layout, color, lighting | copy composition logic, not exact text |
| `base_image` | transform this specific image into a cover | keep core subject and spatial relation |
| `content_context` | helps understand topic/content only | do not visually copy unless also marked as identity/style |

## Reuse Policy

- A cover is not a normal illustration. It needs a title safe area, feed readability, and one instant reason to click.
- A short-video cover is not a carousel card. It should feel like a selected high-energy frame.
- A Pinterest pin should feel saveable; a square poster usually weakens it.
- A commerce product image should not be reused as a social cover without adding a hook, scene, or social proof.
