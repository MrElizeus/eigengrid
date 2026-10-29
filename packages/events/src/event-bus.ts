import type { EigenGridEvent } from "./types";

type Handler = (event: EigenGridEvent) => void;

export interface EventBus {
  emit(event: EigenGridEvent): void;
  on<T extends EigenGridEvent["type"]>(
    type: T,
    handler: (event: Extract<EigenGridEvent, { type: T }>) => void,
  ): () => void;
  off<T extends EigenGridEvent["type"]>(
    type: T,
    handler: (event: Extract<EigenGridEvent, { type: T }>) => void,
  ): void;
}

export class InProcessEventBus implements EventBus {
  private listeners = new Map<string, Set<Handler>>();

  emit(event: EigenGridEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event as EigenGridEvent);
      }
    }
  }

  on<T extends EigenGridEvent["type"]>(
    type: T,
    handler: (event: Extract<EigenGridEvent, { type: T }>) => void,
  ): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler as Handler);
    return () => this.off(type, handler);
  }

  off<T extends EigenGridEvent["type"]>(
    type: T,
    handler: (event: Extract<EigenGridEvent, { type: T }>) => void,
  ): void {
    this.listeners.get(type)?.delete(handler as Handler);
  }
}
