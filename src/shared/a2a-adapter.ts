import type { HubResultStatus } from "../types";
import type { OutputDelta } from "./stream-adapter";

export const A2A_TASK_STATES = ["working", "completed", "failed"] as const;
export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

export type A2APart = { type: "text"; text: string } | { type: "data"; data: unknown };

export interface A2AMessage {
  taskId: string;
  taskState: A2ATaskState;
  parts: A2APart[];
  agentId?: string;
}

export interface A2AAdapter {
  outputDeltaToA2A(delta: OutputDelta): A2AMessage;
  hubResultStatusToTaskState(status: HubResultStatus): A2ATaskState;
}

function outputPhaseToTaskState(phase: OutputDelta["phase"]): A2ATaskState {
  switch (phase) {
    case "working":
      return "working";
    case "result":
      return "completed";
    case "error":
      return "failed";
  }
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

export function outputDeltaToA2A(delta: OutputDelta): A2AMessage {
  const parts: A2APart[] = [];

  if (typeof delta.text === "string") {
    parts.push({ type: "text", text: delta.text });
  }
  if (delta.data !== undefined) {
    parts.push({ type: "data", data: delta.data });
  }

  return {
    taskId: delta.traceId,
    taskState: outputPhaseToTaskState(delta.phase),
    parts
  };
}

export class DefaultA2AAdapter implements A2AAdapter {
  outputDeltaToA2A(delta: OutputDelta): A2AMessage {
    return outputDeltaToA2A(delta);
  }

  hubResultStatusToTaskState(status: HubResultStatus): A2ATaskState {
    return hubResultStatusToTaskState(status);
  }
}
