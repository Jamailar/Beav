type DebugPayload = Record<string, unknown>;

export function uiDebugEnabled(): boolean {
  return false;
}

export function uiDebug(_scope: string, _event: string, _payload?: DebugPayload): void {}

export async function uiMeasure<T>(
  _scope: string,
  _event: string,
  task: () => Promise<T>,
  _payload?: DebugPayload,
): Promise<T> {
  return task();
}

export function uiTraceInteraction(
  _scope: string,
  _event: string,
  _payload?: DebugPayload,
): void {}
