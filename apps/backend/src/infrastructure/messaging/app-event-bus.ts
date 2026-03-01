import { EventEmitter } from "events";
import type { EventBus } from "@/domain/events/event-bus";

export class AppEventBus extends EventEmitter implements EventBus {
  private sseEmitter?: (event: string, data?: unknown) => void;

  setSseEmitter(emitter: (event: string, data?: unknown) => void): void {
    this.sseEmitter = emitter;
  }

  // Override emit to send to both internal listeners and SSE
  emit(event: string, data?: unknown): boolean {
    // 1. Emit to internal Node.js listeners
    const result = super.emit(event, data);

    // 2. Emit to Frontend via SSE
    // (We only send data if it's serializable, which it usually is in this app)
    this.sseEmitter?.(event, data);

    return result;
  }
}
