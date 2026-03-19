# Adding a New Role

This guide shows the minimum changes required to add a new role type to `meridian-roles`. The example role is `EchoRole`, a tiny role that sends one prompt to Meridian and forwards the result back to the original user reply channel.

## Step 1: Implement the role

Create a new definition file under `src/roles/definitions/`. The role must satisfy `BaseRole` from `src/roles/base-role.ts`.

```ts
import { randomUUID } from "node:crypto";

import { ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../../config";
import type { HubResult, ReplyChannel } from "../../types";
import type { BaseRole, RoleContext } from "../base-role";

export interface EchoRoleConfig {
  prompt: string;
  target_thread_id: string;
  user_reply_channel?: ReplyChannel;
}

export class EchoRole implements BaseRole {
  readonly roleType = "echo" as const;
  readonly threadId: string;
  readonly config: EchoRoleConfig;

  private ctx: RoleContext | null = null;
  private outboundTraceId: string | null = null;

  constructor(threadId: string, config: EchoRoleConfig) {
    this.threadId = threadId;
    this.config = config;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;
    this.outboundTraceId = randomUUID();

    await ctx.sendToHub({
      trace_id: this.outboundTraceId,
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: this.config.target_thread_id,
      priority: 5,
      payload: {
        content: this.config.prompt,
        attachments: []
      },
      mode: "bridge",
      reply_channel: {
        channel: "socket",
        chat_id: ROLES_SERVICE_ID,
        socket_path: ROLES_SOCKET_PATH
      },
      suppress_reply: false
    });
  }

  async onDeactivate(): Promise<void> {
    this.ctx = null;
  }

  async onInboundResult(result: HubResult): Promise<void> {
    if (!this.ctx || result.trace_id !== this.outboundTraceId || !this.config.user_reply_channel) {
      return;
    }

    await this.ctx.sendToHub({
      trace_id: randomUUID(),
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: "global",
      priority: 5,
      payload: {
        content: result.content,
        attachments: []
      },
      mode: "bridge",
      reply_channel: this.config.user_reply_channel,
      suppress_reply: true
    });
  }

  async onStatusChange(): Promise<void> {
    return undefined;
  }
}
```

## Step 2: Extend the shared types

Update `src/types.ts`:

1. Add `"echo"` to `RoleTypeSchema`.
2. Add an `EchoRoleConfigSchema`.
3. Extend any API request schemas that need to accept the new role type.

Example:

```ts
export const RoleTypeSchema = z.enum(["dispatcher", "echo"]);

export const EchoRoleConfigSchema = z.object({
  prompt: z.string().min(1),
  target_thread_id: z.string().min(1),
  user_reply_channel: ReplyChannelSchema.optional()
});
```

## Step 3: Register the factory

Wire the role into bootstrap where the service builds `RoleRegistry`.

Today that happens in `src/index.ts`:

```ts
registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore }));
registry.register("echo", (threadId, config) => new EchoRole(threadId, EchoRoleConfigSchema.parse(config)));
```

`RoleRegistry.create()` is strict. If the new type is not registered, role activation fails immediately.

## Step 4: Update the HTTP create path

`src/server/role-handlers.ts` currently normalizes dispatcher-only create bodies. To add a real new role type, update:

1. `CreateRoleBodySchema` so it accepts the new role's config fields.
2. `normalizeCreateBody()` so it validates `echo` config with `EchoRoleConfigSchema`.
3. Any detail/list response shaping if the new role needs custom fields.

If the role needs prompt editing, also extend `src/roles/prompt-store.ts` and `src/server/prompt-handlers.ts` so the role can expose prompt snapshots safely.

## Step 5: Add GUI wiring

The current GUI routes are:

- `/` -> dashboard
- `/role/:thread_id` -> detail page
- `/role/:thread_id/prompts` -> prompt editor

If the new role can reuse the existing detail page, only the API responses may need changes. If it needs a custom editor:

1. Add a new page in `src/web/public/`.
2. Map the route in `src/server/http-server.ts`.
3. Add the client-side page logic in `src/web/public/app.js`.
4. Add a visible link from the dashboard or detail page.

## Testing checklist

At minimum, add:

- unit tests for the new role's activation and inbound result handling
- create/delete API coverage in `src/server/role-handlers.ts`
- one E2E scenario under `tests/e2e/` that exercises the role through the real A2A socket callback path

`EchoRole` is intentionally small. If a new role needs long-lived state, follow `DispatcherRole` and persist through `StateStore` instead of keeping important data only in memory.
