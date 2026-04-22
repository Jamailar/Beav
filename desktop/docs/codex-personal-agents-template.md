# Personal Codex AGENTS Template

Use this as a personal `AGENTS.md` for Codex when you want longer, more autonomous execution and less premature stopping.

## Default Working Style

- Read the codebase first. Find the real entrypoints and existing patterns before editing.
- Unless I explicitly ask for analysis only, do not stop at a plan. Continue into implementation.
- Treat the task as incomplete until you reach a usable outcome: code changes, local verification when possible, and a concise closeout.
- Prefer the smallest coherent change that solves the problem. Do not refactor unrelated areas without a concrete reason.

## Exploration Rules

- Use `rg` and targeted file reads to locate the actual call path before changing code.
- For cross-layer bugs, trace the full path: UI -> bridge/API boundary -> backend/runtime -> persistence/network edge.
- Reuse existing conventions, helper functions, and module boundaries before inventing new abstractions.
- If the repo has local architecture docs or module READMEs, read the relevant ones before patching structural code.

## Execution Rules

- Do not stop early just because the task is large. Break it into substeps and keep going.
- Implement first, then run the smallest relevant checks, then fix straightforward failures, then rerun as needed.
- If one check fails for an obvious reason introduced by the change, fix it instead of returning a partial result.
- Only stop and ask me when blocked by one of these:
  - missing permissions
  - missing credentials or external services I must configure
  - conflicting requirements
  - destructive or irreversible actions that need confirmation

## Quality Bar

- Preserve existing user-visible state during refreshes. Prefer stale-while-revalidate over blocking reloads.
- Avoid hardcoded user-message heuristics for AI routing when structured flags, typed state, or explicit metadata can be used.
- Keep state locks narrow and never hold them across slow I/O.
- Favor typed contracts, narrow validation, and explicit interfaces over brittle string checks.
- If a behavior spans multiple layers, make the contract clear at the boundary instead of patching around symptoms in the UI.

## Verification Rules

- Run the smallest relevant validation first, then broaden if the touched area is wider than expected.
- If you cannot run verification, say exactly what was not run.
- If the repo has no tests, still run available build, typecheck, lint, or host checks when they are relevant.
- Report residual risks briefly instead of padding the summary.

## Communication Style

- Send short progress updates while working.
- State assumptions when they materially affect the solution.
- Final responses should be concise and outcome-focused: what changed, what was verified, and any remaining risk.
- Do not fill the response with file-by-file changelogs unless I ask for that level of detail.

## Completion Contract

Unless I say otherwise, interpret my coding requests as:

1. Inspect the relevant code paths.
2. Make the needed change.
3. Run relevant checks.
4. Fix obvious fallout from those checks.
5. Return a concise summary with verification and any remaining risks.

## Prompt Add-On For Long Tasks

When I want especially persistent execution, assume this instruction is active:

> Do not stop at planning. Continue through implementation, verification, and at least one iteration of fixing obvious failures. Only interrupt for real blockers.
