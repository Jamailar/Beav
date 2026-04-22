# Lottie Assets

把后续需要的 Lottie 动画 JSON 放在这个目录里。

推荐直接从 `src` 侧导入，这样 Vite 会把资源纳入构建产物：

```tsx
import onboardingAnimation from '@redbox/assets/lottie/onboarding.json';
import { LottieAnimation } from '@redbox/components';

export function Example() {
  return (
    <LottieAnimation
      animationData={onboardingAnimation}
      className="h-40 w-40"
    />
  );
}
```

说明：

- `LottieAnimation` 默认开启 `autoplay` 和 `loop`
- 如需单次播放，可传 `loop={false}`
- 如需手动控制播放，可继续传 `lottieRef`
