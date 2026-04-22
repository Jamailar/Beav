// Adapted directly from Claude Code's restored-src/src/utils/cron.ts.
// Minimal cron expression parsing and next-run calculation.
//
// Supports the standard 5-field cron subset:
//   minute hour day-of-month month day-of-week
//
// Field syntax: wildcard, N, step (star-slash-N), range (N-M), list (N,M,...).
// No L, W, ?, or name aliases. All times are interpreted in the process's
// local timezone.

export type CronFields = {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
};

type FieldRange = { min: number; max: number };

const FIELD_RANGES: FieldRange[] = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 6 },
];

function expandField(field: string, range: FieldRange): number[] | null {
    const { min, max } = range;
    const out = new Set<number>();

    for (const part of field.split(',')) {
        const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
        if (stepMatch) {
            const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;
            if (step < 1) return null;
            for (let i = min; i <= max; i += step) out.add(i);
            continue;
        }

        const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1]!, 10);
            const hi = parseInt(rangeMatch[2]!, 10);
            const step = rangeMatch[3] ? parseInt(rangeMatch[3]!, 10) : 1;
            const isDow = min === 0 && max === 6;
            const effMax = isDow ? 7 : max;
            if (lo > hi || step < 1 || lo < min || hi > effMax) return null;
            for (let i = lo; i <= hi; i += step) {
                out.add(isDow && i === 7 ? 0 : i);
            }
            continue;
        }

        if (/^\d+$/.test(part)) {
            let n = parseInt(part, 10);
            if (min === 0 && max === 6 && n === 7) n = 0;
            if (n < min || n > max) return null;
            out.add(n);
            continue;
        }

        return null;
    }

    if (out.size === 0) return null;
    return Array.from(out).sort((a, b) => a - b);
}

export function parseCronExpression(expr: string): CronFields | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const expanded: number[][] = [];
    for (let i = 0; i < 5; i += 1) {
        const result = expandField(parts[i]!, FIELD_RANGES[i]!);
        if (!result) return null;
        expanded.push(result);
    }

    return {
        minute: expanded[0]!,
        hour: expanded[1]!,
        dayOfMonth: expanded[2]!,
        month: expanded[3]!,
        dayOfWeek: expanded[4]!,
    };
}

export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
    const minuteSet = new Set(fields.minute);
    const hourSet = new Set(fields.hour);
    const domSet = new Set(fields.dayOfMonth);
    const monthSet = new Set(fields.month);
    const dowSet = new Set(fields.dayOfWeek);

    const domWild = fields.dayOfMonth.length === 31;
    const dowWild = fields.dayOfWeek.length === 7;

    const t = new Date(from.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);

    const maxIter = 366 * 24 * 60;
    for (let i = 0; i < maxIter; i += 1) {
        const month = t.getMonth() + 1;
        if (!monthSet.has(month)) {
            t.setMonth(t.getMonth() + 1, 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        const dom = t.getDate();
        const dow = t.getDay();
        const dayMatches =
            domWild && dowWild
                ? true
                : domWild
                  ? dowSet.has(dow)
                  : dowWild
                    ? domSet.has(dom)
                    : domSet.has(dom) || dowSet.has(dow);

        if (!dayMatches) {
            t.setDate(t.getDate() + 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        if (!hourSet.has(t.getHours())) {
            t.setHours(t.getHours() + 1, 0, 0, 0);
            continue;
        }

        if (!minuteSet.has(t.getMinutes())) {
            t.setMinutes(t.getMinutes() + 1);
            continue;
        }

        return t;
    }

    return null;
}

export function nextCronRunMs(expr: string, fromMs: number): number | null {
    const fields = parseCronExpression(expr);
    if (!fields) return null;
    const next = computeNextCronRun(fields, new Date(fromMs));
    return next ? next.getTime() : null;
}
