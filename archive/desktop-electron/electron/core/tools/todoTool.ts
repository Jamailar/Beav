import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';
import { Filesystem } from '../util/filesystem';

const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
const TodoPrioritySchema = z.enum(['low', 'medium', 'high']);

const TodoItemSchema = z.object({
    id: z.string().describe("Unique identifier for the todo item"),
    content: z.string().describe("Brief description of the task"),
    status: TodoStatusSchema.describe("Current status of the task"),
    priority: TodoPrioritySchema.describe("Priority level of the task"),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

const TodoWriteParamsSchema = z.object({
    todos: z.array(TodoItemSchema).describe("The updated todo list"),
    merge: z.boolean().optional().describe("Whether to merge with existing todos (update by ID) or replace all"),
    summary: z.string().optional().describe("Summary of work accomplished (only when marking tasks as completed)"),
});

type TodoWriteParams = z.infer<typeof TodoWriteParamsSchema>;

const TodoReadParamsSchema = z.object({});
type TodoReadParams = z.infer<typeof TodoReadParamsSchema>;

async function getTodoFilePath(): Promise<string> {
    const dir = path.join(Instance.directory, '.opencode');
    if (!(await Filesystem.exists(dir))) {
        await fs.mkdir(dir, { recursive: true });
    }
    return path.join(dir, 'todo.json');
}

export class TodoWriteTool extends DeclarativeTool<typeof TodoWriteParamsSchema> {
    readonly name = 'todo_write';
    readonly displayName = 'Manage Todo List';
    readonly description = 'Create and manage a structured task list. Use this to track progress on complex tasks.';
    readonly kind = ToolKind.Other; // Or specialized 'Todo' kind
    readonly parameterSchema = TodoWriteParamsSchema;
    readonly requiresConfirmation = false;

    protected validateValues(params: TodoWriteParams): string | null {
        // Validate that only one task is in_progress
        const inProgress = params.todos.filter(t => t.status === 'in_progress');
        if (inProgress.length > 1) {
            // This is a soft validation, maybe just warn or allow it? 
            // opencode instructions say "limit to ONE task at a time"
            // We'll enforce it? No, sometimes user might want parallel. Let's just warn in description if possible.
        }
        return null;
    }

    getDescription(params: TodoWriteParams): string {
        return `Update todo list: ${params.todos.length} items`;
    }

    async execute(params: TodoWriteParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            const filePath = await getTodoFilePath();
            let currentTodos: TodoItem[] = [];
            
            if (await Filesystem.exists(filePath)) {
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    currentTodos = JSON.parse(content);
                } catch {
                    // Ignore parsing error, start fresh
                }
            }

            let newTodos = params.todos;

            if (params.merge) {
                const todoMap = new Map(currentTodos.map(t => [t.id, t]));
                for (const todo of params.todos) {
                    todoMap.set(todo.id, todo);
                }
                newTodos = Array.from(todoMap.values());
            }

            await fs.writeFile(filePath, JSON.stringify(newTodos, null, 2), 'utf-8');

            const pending = newTodos.filter(t => t.status === 'pending').length;
            const inProgress = newTodos.filter(t => t.status === 'in_progress').length;
            const completed = newTodos.filter(t => t.status === 'completed').length;

            let output = `Todo list updated.\nPending: ${pending}, In Progress: ${inProgress}, Completed: ${completed}`;
            if (params.summary) {
                output += `\n\nSummary: ${params.summary}`;
            }

            return createSuccessResult(output, `📝 Todos updated (${newTodos.length} items)`);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to write todos: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}

export class TodoReadTool extends DeclarativeTool<typeof TodoReadParamsSchema> {
    readonly name = 'todo_read';
    readonly displayName = 'Read Todo List';
    readonly description = 'Read the current todo list.';
    readonly kind = ToolKind.Read;
    readonly parameterSchema = TodoReadParamsSchema;
    readonly requiresConfirmation = false;

    protected validateValues(params: TodoReadParams): string | null {
        return null;
    }

    getDescription(params: TodoReadParams): string {
        return 'Read todo list';
    }

    async execute(params: TodoReadParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            const filePath = await getTodoFilePath();
            if (!(await Filesystem.exists(filePath))) {
                 return createSuccessResult("No todo list found. Create one with todo_write.", "📝 No todos");
            }

            const content = await fs.readFile(filePath, 'utf-8');
            const todos: TodoItem[] = JSON.parse(content);
            
            if (todos.length === 0) {
                 return createSuccessResult("Todo list is empty.", "📝 Empty list");
            }

            const activeTodos = todos.filter(t => t.status !== 'cancelled'); // Maybe hide cancelled?
            // Or just show all. opencode shows all but highlights status.
            
            return createSuccessResult(JSON.stringify(todos, null, 2), `📝 ${todos.length} todos`);

        } catch (error) {
             const message = error instanceof Error ? error.message : String(error);
             return createErrorResult(`Failed to read todos: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
