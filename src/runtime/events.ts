import type { ExecutionEventType } from "../models/enums";

export type ExecutionEvent = {
  type: ExecutionEventType;
  timestamp: Date;
  data: Record<string, unknown>;
};

export interface EventHandler {
  onEvent(event: ExecutionEvent): void;
}

export class EventBus {
  private handlers: EventHandler[] = [];

  subscribe(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  unsubscribe(handler: EventHandler): void {
    this.handlers = this.handlers.filter((item) => item !== handler);
  }

  emit(event: ExecutionEvent): void {
    for (const handler of this.handlers) {
      handler.onEvent(event);
    }
  }

  emitEvent(eventType: ExecutionEventType, data: Record<string, unknown> = {}): void {
    this.emit({ type: eventType, timestamp: new Date(), data });
  }
}

export class NoopEventHandler implements EventHandler {
  onEvent(_event: ExecutionEvent): void {}
}
