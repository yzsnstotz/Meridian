---
name: meridian-orchestrator
description: Manage and dispatch task units to workers for the Meridian v2.0 upgrade based on the meridian_v2_taskspec.docx file.
---

# Meridian Orchestrator

This skill helps you manage the multi-worker workflow for Meridian v2.0.

## Workflow Overview

The Meridian v2.0 upgrade is divided into **Waves**. Each wave assigns specific tasks (T-XX) to different workers (W1, W2, etc.).

## Dispatch Instructions

When asked to provide prompts for a specific wave, always use the following template for each worker:

### Worker Prompt Template

> **Role:** [Worker Name (e.g., Worker 1)]
> **Current Wave:** [Wave Name (e.g., Wave 1)]
> **Tasks:** [Task IDs (e.g., T-01)]
> **Session Strategy:** [New Session / Share Session]
>
> **Instruction:** You are **[Worker Name]** for **[Wave Name]**. Please refer to the TaskSpec document at `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`. Your assigned task(s) are **[Task IDs]**. Please follow the document to accomplish the corresponding tasks. Ensure you read the required context files before modification.

## Dispatch Table Reference

For the mapping of waves, workers, and tasks, refer to the [dispatch-table.md](references/dispatch-table.md) file.
