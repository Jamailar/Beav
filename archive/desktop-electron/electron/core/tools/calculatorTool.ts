/**
 * Calculator Tool - 计算器工具
 *
 * 执行数学计算
 */

import { z } from 'zod';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
} from '../toolRegistry';

// 参数 Schema
const CalculatorParamsSchema = z.object({
    expression: z.string().describe('The mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)", "sin(45)")'),
});

type CalculatorParams = z.infer<typeof CalculatorParamsSchema>;

/**
 * 计算器工具 - 使用 mathjs 或内置函数
 */
export class CalculatorTool extends DeclarativeTool<typeof CalculatorParamsSchema> {
    readonly name = 'calculator';
    readonly displayName = 'Calculator';
    readonly description = 'Evaluate mathematical expressions. Supports basic arithmetic, trigonometry, logarithms, and more.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = CalculatorParamsSchema;
    readonly requiresConfirmation = false;

    getDescription(params: CalculatorParams): string {
        return `Calculate: ${params.expression}`;
    }

    async execute(params: CalculatorParams): Promise<ToolResult> {
        try {
            const result = this.evaluate(params.expression);

            return createSuccessResult(
                `The result of "${params.expression}" is: ${result}`,
                `🧮 ${params.expression} = ${result}`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Calculation failed: ${message}`);
        }
    }

    /**
     * 简单的数学表达式求值
     */
    private evaluate(expression: string): string {
        // 预处理：替换常用数学函数
        let expr = expression
            .replace(/sqrt\(/g, 'Math.sqrt(')
            .replace(/abs\(/g, 'Math.abs(')
            .replace(/sin\(/g, 'Math.sin(')
            .replace(/cos\(/g, 'Math.cos(')
            .replace(/tan\(/g, 'Math.tan(')
            .replace(/log\(/g, 'Math.log10(')
            .replace(/ln\(/g, 'Math.log(')
            .replace(/exp\(/g, 'Math.exp(')
            .replace(/pow\(/g, 'Math.pow(')
            .replace(/PI/gi, 'Math.PI')
            .replace(/E/gi, 'Math.E')
            .replace(/\^/g, '**');

        // 使用 Function 构造函数求值（安全限制）
        const allowedGlobals = {
            Math: Math,
            abs: Math.abs,
            sin: Math.sin,
            cos: Math.cos,
            tan: Math.tan,
            sqrt: Math.sqrt,
            pow: Math.pow,
            log: Math.log,
            log10: Math.log10,
            exp: Math.exp,
            PI: Math.PI,
            E: Math.E,
            max: Math.max,
            min: Math.min,
            round: Math.round,
            floor: Math.floor,
            ceil: Math.ceil,
        };

        const keys = Object.keys(allowedGlobals);
        const values = Object.values(allowedGlobals);

        try {
            const fn = new Function(...keys, `return ${expr}`);
            const result = fn(...values);

            if (typeof result === 'number') {
                if (Number.isInteger(result)) {
                    return result.toString();
                }
                // 保留合理精度
                return result.toFixed(10).replace(/\.?0+$/, '');
            }
            return String(result);
        } catch (e) {
            throw new Error(`Invalid expression: ${expression}`);
        }
    }
}
