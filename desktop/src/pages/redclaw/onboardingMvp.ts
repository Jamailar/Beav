export type RedClawOnboardingSliderQuestionId =
  | 'contentVsCommerce'
  | 'personaVsBrand'
  | 'consistencyVsVirality'
  | 'authorityPosture'
  | 'emotionalTemperature'
  | 'salesExplicitness'
  | 'structureValue';

export type RedClawOnboardingChoiceQuestionId =
  | 'primaryModel'
  | 'rolePosition';

export type RedClawOnboardingAbQuestionId =
  | 'openingPreference';

export type RedClawOnboardingQuestionId =
  | RedClawOnboardingSliderQuestionId
  | RedClawOnboardingChoiceQuestionId
  | RedClawOnboardingAbQuestionId;

export interface RedClawOnboardingAnswers {
  contentVsCommerce: number;
  personaVsBrand: number;
  consistencyVsVirality: number;
  authorityPosture: number;
  emotionalTemperature: number;
  salesExplicitness: number;
  structureValue: number;
  primaryModel: 'persona-commerce' | 'brand-commerce' | 'service-conversion' | 'content-account';
  rolePosition: 'advisor' | 'experienced' | 'experimenter' | 'founder';
  openingPreference: 'hook' | 'observational';
}

type SliderQuestion = {
  id: RedClawOnboardingSliderQuestionId;
  type: 'slider';
  title: string;
  description: string;
  minLabel: string;
  maxLabel: string;
  helper: (value: number) => string;
};

type ChoiceQuestion = {
  id: RedClawOnboardingChoiceQuestionId;
  type: 'choice';
  title: string;
  description: string;
  options: Array<{
    value: RedClawOnboardingAnswers[RedClawOnboardingChoiceQuestionId];
    label: string;
    description: string;
  }>;
};

type AbQuestion = {
  id: RedClawOnboardingAbQuestionId;
  type: 'ab';
  title: string;
  description: string;
  options: Array<{
    value: RedClawOnboardingAnswers[RedClawOnboardingAbQuestionId];
    label: string;
    body: string[];
    caption: string;
  }>;
};

export type RedClawOnboardingQuestion = SliderQuestion | ChoiceQuestion | AbQuestion;

export const REDCLAW_ONBOARDING_MVP_QUESTIONS: RedClawOnboardingQuestion[] = [
  {
    id: 'contentVsCommerce',
    type: 'slider',
    title: '这个空间整体更偏内容，还是更偏商业？',
    description: '先定义经营重心。这个值会影响我后续帮你定选题、写文案和安排转化的默认方向。',
    minLabel: '内容导向',
    maxLabel: '商业导向',
    helper: (value) => {
      if (value <= 20) return '强内容导向，优先停留、收藏、关注。';
      if (value <= 40) return '内容优先，允许轻商业转化。';
      if (value <= 60) return '内容与商业平衡。';
      if (value <= 80) return '商业优先，但仍需要内容包装。';
      return '强商业导向，优先成交效率。';
    },
  },
  {
    id: 'personaVsBrand',
    type: 'slider',
    title: '这个空间更依赖经营你这个人，还是经营品牌本身？',
    description: '这会决定内容里的信任来源，是更强调个人判断，还是更强调品牌体系。',
    minLabel: '品牌驱动',
    maxLabel: '人设驱动',
    helper: (value) => {
      if (value <= 20) return '强品牌驱动，更依赖品牌定位和产品体系。';
      if (value <= 40) return '品牌略优先，但还保留一定个人表达。';
      if (value <= 60) return '人设与品牌基本平衡。';
      if (value <= 80) return '人设略优先，更依赖你的判断力与表达。';
      return '强人设驱动，核心是经营“谁在推荐”。';
    },
  },
  {
    id: 'consistencyVsVirality',
    type: 'slider',
    title: '这个空间更应该追求长期一致性，还是短期爆发力？',
    description: '这会影响内容节奏，是先稳住品牌一致性，还是优先冲传播效率。',
    minLabel: '一致性优先',
    maxLabel: '爆发力优先',
    helper: (value) => {
      if (value <= 20) return '长期一致性优先，先建立稳定认知。';
      if (value <= 40) return '一致性略优先，允许少量爆点。';
      if (value <= 60) return '一致性与爆发力平衡。';
      if (value <= 80) return '爆发力略优先，但不完全放弃统一风格。';
      return '爆发力优先，默认更敢做强钩子与更猛表达。';
    },
  },
  {
    id: 'authorityPosture',
    type: 'slider',
    title: '你更希望账号给人的感觉是专业判断，还是亲近自然？',
    description: '这决定账号的第一印象，会影响权威感、距离感和表达姿态。',
    minLabel: '亲近自然',
    maxLabel: '专业判断',
    helper: (value) => {
      if (value <= 20) return '偏朋友感，距离更近。';
      if (value <= 40) return '亲近但保留判断力。';
      if (value <= 60) return '专业与亲近平衡。';
      if (value <= 80) return '偏专业判断，语气会更稳。';
      return '强专业判断，默认更像顾问或策略角色。';
    },
  },
  {
    id: 'emotionalTemperature',
    type: 'slider',
    title: '文案整体更应该冷静克制，还是更有情绪感染力？',
    description: '这决定情绪浓度，不是好坏判断，而是你长期最舒服、最像自己的表达区间。',
    minLabel: '冷静克制',
    maxLabel: '情绪感染',
    helper: (value) => {
      if (value <= 20) return '极冷静，强调判断与克制。';
      if (value <= 40) return '偏冷静，少煽动。';
      if (value <= 60) return '冷静与感染平衡。';
      if (value <= 80) return '偏有感染力，但不至于太热。';
      return '强感染表达，情绪驱动更明显。';
    },
  },
  {
    id: 'salesExplicitness',
    type: 'slider',
    title: '内容里的转化表达应该更隐性，还是更显性？',
    description: '这会影响文案里的产品露出、行动指令和 CTA 强度。',
    minLabel: '弱转化',
    maxLabel: '强转化',
    helper: (value) => {
      if (value <= 20) return '基本不直接转化，更像纯内容。';
      if (value <= 40) return '偏隐性转化，更多是信任铺垫。';
      if (value <= 60) return '中性转化，既不回避也不强推。';
      if (value <= 80) return '偏显性转化，会明确推动动作。';
      return '强转化导向，默认更直接地促进行动。';
    },
  },
  {
    id: 'structureValue',
    type: 'slider',
    title: '文案更应该偏框架拆解，还是偏故事化表达？',
    description: '这决定正文组织方式，会影响你更像在拆方法，还是在讲一个过程。',
    minLabel: '故事表达',
    maxLabel: '框架拆解',
    helper: (value) => {
      if (value <= 20) return '偏故事表达，更依赖场景和推进感。';
      if (value <= 40) return '故事略优先，但还带方法。';
      if (value <= 60) return '框架与故事平衡。';
      if (value <= 80) return '框架略优先，更适合拆清楚步骤和判断。';
      return '偏框架拆解，默认更强调结构和结论。';
    },
  },
  {
    id: 'primaryModel',
    type: 'choice',
    title: '这个空间目前最接近哪一种经营方式？',
    description: 'MVP 先用一个基础分类来决定默认策略分支。',
    options: [
      {
        value: 'persona-commerce',
        label: '人设带货',
        description: '经营“谁在推荐”，可跨品牌，信任主要来自你的判断和人设。',
      },
      {
        value: 'brand-commerce',
        label: '品牌带货',
        description: '围绕一个品牌或产品体系经营，强调品牌一致性和长期心智。',
      },
      {
        value: 'service-conversion',
        label: '高客单服务转化',
        description: '核心是专业判断、案例证明和服务信任，不是低价快销。',
      },
      {
        value: 'content-account',
        label: '纯内容账号',
        description: '以点赞、收藏、关注、留存为主，商业是后续衍生结果。',
      },
    ],
  },
  {
    id: 'rolePosition',
    type: 'choice',
    title: '你希望受众主要把你视为什么角色？',
    description: '这道题决定账号的人物姿态，会影响第一人称比例、判断口吻和距离感。',
    options: [
      {
        value: 'advisor',
        label: '专业顾问',
        description: '强调判断力、分析能力和方法论。',
      },
      {
        value: 'experienced',
        label: '有经验的过来人',
        description: '更像前辈，带真实经验和踩坑感。',
      },
      {
        value: 'experimenter',
        label: '真实试错者',
        description: '强调过程、实验、真实迭代和观察。',
      },
      {
        value: 'founder',
        label: '品牌主理人',
        description: '更强调主理人视角、品牌判断和长期经营。',
      },
    ],
  },
  {
    id: 'openingPreference',
    type: 'ab',
    title: '下面两种开头，你更愿意长期采用哪一种？',
    description: 'MVP 先保留一组最关键的文案样例，用来区分“强判断钩子”和“观察式开头”。',
    options: [
      {
        value: 'hook',
        label: 'A',
        body: [
          '很多人以为卖不动，是流量不够。',
          '但多数时候，问题根本不在流量。',
        ],
        caption: '更强判断、更直接打钩子。',
      },
      {
        value: 'observational',
        label: 'B',
        body: [
          '这周我重新看了 37 条转化不错的内容。',
          '最后发现，真正影响成交的不是你想的那个点。',
        ],
        caption: '更观察式、更像先拉你进入一个判断过程。',
      },
    ],
  },
];

export const REDCLAW_ONBOARDING_DEFAULT_ANSWERS: RedClawOnboardingAnswers = {
  contentVsCommerce: 50,
  personaVsBrand: 50,
  consistencyVsVirality: 50,
  authorityPosture: 68,
  emotionalTemperature: 35,
  salesExplicitness: 52,
  structureValue: 66,
  primaryModel: 'content-account',
  rolePosition: 'advisor',
  openingPreference: 'hook',
};

export function normalizeOnboardingAnswers(
  value: Record<string, unknown> | null | undefined,
): RedClawOnboardingAnswers {
  const raw = value || {};
  const readPercent = (key: RedClawOnboardingSliderQuestionId, fallback: number) => {
    const candidate = Number(raw[key]);
    if (!Number.isFinite(candidate)) return fallback;
    return Math.max(0, Math.min(100, Math.round(candidate)));
  };
  const primaryModel = String(raw.primaryModel || REDCLAW_ONBOARDING_DEFAULT_ANSWERS.primaryModel);
  const rolePosition = String(raw.rolePosition || REDCLAW_ONBOARDING_DEFAULT_ANSWERS.rolePosition);
  const openingPreference = String(raw.openingPreference || REDCLAW_ONBOARDING_DEFAULT_ANSWERS.openingPreference);

  return {
    contentVsCommerce: readPercent('contentVsCommerce', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.contentVsCommerce),
    personaVsBrand: readPercent('personaVsBrand', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.personaVsBrand),
    consistencyVsVirality: readPercent('consistencyVsVirality', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.consistencyVsVirality),
    authorityPosture: readPercent('authorityPosture', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.authorityPosture),
    emotionalTemperature: readPercent('emotionalTemperature', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.emotionalTemperature),
    salesExplicitness: readPercent('salesExplicitness', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.salesExplicitness),
    structureValue: readPercent('structureValue', REDCLAW_ONBOARDING_DEFAULT_ANSWERS.structureValue),
    primaryModel: (
      ['persona-commerce', 'brand-commerce', 'service-conversion', 'content-account'].includes(primaryModel)
        ? primaryModel
        : REDCLAW_ONBOARDING_DEFAULT_ANSWERS.primaryModel
    ) as RedClawOnboardingAnswers['primaryModel'],
    rolePosition: (
      ['advisor', 'experienced', 'experimenter', 'founder'].includes(rolePosition)
        ? rolePosition
        : REDCLAW_ONBOARDING_DEFAULT_ANSWERS.rolePosition
    ) as RedClawOnboardingAnswers['rolePosition'],
    openingPreference: (
      ['hook', 'observational'].includes(openingPreference)
        ? openingPreference
        : REDCLAW_ONBOARDING_DEFAULT_ANSWERS.openingPreference
    ) as RedClawOnboardingAnswers['openingPreference'],
  };
}

export function onboardingProgressLabel(stepIndex: number): string {
  return `${Math.max(1, Math.min(REDCLAW_ONBOARDING_MVP_QUESTIONS.length, stepIndex + 1))}/${REDCLAW_ONBOARDING_MVP_QUESTIONS.length}`;
}

