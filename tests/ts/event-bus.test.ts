import { describe, it, expect } from "bun:test";
import { InProcessEventBus } from "@eigengrid/events";

describe("EventBus", () => {
  it("emits and receives events", () => {
    const bus = new InProcessEventBus();
    const received: string[] = [];
    const unsub = bus.on("job:created", (e) => received.push(e.jobId));
    bus.emit({ type: "job:created", jobId: "test-1", at: Date.now() });
    expect(received).toEqual(["test-1"]);
    unsub();
    bus.emit({ type: "job:created", jobId: "test-2", at: Date.now() });
    expect(received).toEqual(["test-1"]);
  });

  it("handles multiple subscribers", () => {
    const bus = new InProcessEventBus();
    let count = 0;
    bus.on("job:created", () => {
      count++;
    });
    bus.on("job:created", () => {
      count++;
    });
    bus.emit({ type: "job:created", jobId: "x", at: Date.now() });
    expect(count).toBe(2);
  });

  it("does not call off handler", () => {
    const bus = new InProcessEventBus();
    let count = 0;
    const fn = () => {
      count++;
    };
    bus.on("job:created", fn);
    bus.off("job:created", fn);
    bus.emit({ type: "job:created", jobId: "x", at: Date.now() });
    expect(count).toBe(0);
  });
});
