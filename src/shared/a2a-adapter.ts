import type { HubResultStatus } from "../types";
import type { OutputDelta } from "./stream-adapter";

export type A2ATaskState = "working" | "completed" | "failed";

export type A2APart = { type: "text"; text: string } | { type: "data"; data: unknown };

export interface A2AMessage {
  taskId: string;
  taskState: A2ATaskState;
  parts: A2APart[];
  agentId?: string;
}

function outputDeltaPhaseToTaskState(phase: OutputDelta["phase"]): A2ATaskState {
  switch (phase) {
    case "working":
      return "working";
    case "result":
      return "completed";
    case "error":
      return "failed";
  }
}

export function outputDeltaToA2A(delta: OutputDelta): A2AMessage {
  const parts: A2APart[] = [];

  if (delta.text !== undefined) {
    parts.push({ type: "text", text: delta.text });
  }

  if (delta.data !== undefined) {
    parts.push({ type: "data", data: delta.data });
  }

  return {
    taskId: delta.traceId,
    taskState: outputDeltaPhaseToTaskState(delta.phase),
    parts
  };
}

export function hubResultStatusToTaskState(status: HubResultStatus): A2ATaskState {
  switch (status) {
    case "partial":
      return "working";
    case "success":
      return "completed";
    case "error":
    case "timeout":
      return "failed";
  }
}

export class A2AAdapter {
  outputDeltaToA2A(delta: OutputDelta): A2AMessage {
    return outputDeltaToA2A(delta);
  }

  hubResultStatusToTaskState(status: HubResultStatus): A2ATaskState {
    return hubResultStatusToTaskState(status);
  }
}
