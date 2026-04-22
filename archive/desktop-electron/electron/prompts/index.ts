import { promptLoader } from './loader';

/**
 * 核心提示词 - 动态从 library 目录加载
 */
export const INTENT_PROMPT = promptLoader.load('intent.txt');
export const PLANNER_PROMPT = promptLoader.load('planner.txt');
export const EXECUTOR_PROMPT = promptLoader.load('executor.txt');
export const SYNTHESIZER_PROMPT = promptLoader.load('synthesizer.txt');
export const VALIDATOR_PROMPT = promptLoader.load('validator.txt');
export const DIRECT_RESPONSE_PROMPT = promptLoader.load('direct_response.txt');
export const WANDER_PROMPT = promptLoader.load('wander.txt');
export const WANDER_BRAINSTORM_PROMPT = promptLoader.load('wander_brainstorm.txt');
export const WANDER_EVALUATE_PROMPT = promptLoader.load('wander_evaluate.txt');


/**
 * 角色提示词 - 动态加载 personas 目录
 */
export const PERSONA_PROMPTS = promptLoader.loadDir('personas');

/**
 * 任务模板提示词 - 动态加载 templates 目录
 */
export const TEMPLATE_PROMPTS = promptLoader.loadDir('templates');
