import Lottie, { type LottieComponentProps } from 'lottie-react';

export type LottieAnimationProps = LottieComponentProps;

export function LottieAnimation({
  autoplay = true,
  loop = true,
  style,
  ...props
}: LottieAnimationProps) {
  return (
    <Lottie
      autoplay={autoplay}
      loop={loop}
      style={{ width: '100%', height: '100%', ...style }}
      {...props}
    />
  );
}
