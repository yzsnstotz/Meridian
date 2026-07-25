import type { RoleType } from "../types";
import type { BaseRole } from "./base-role";

export type RoleFactory = (threadId: string, config: unknown) => BaseRole;

export class RoleRegistry {
  private readonly factories = new Map<RoleType, RoleFactory>();

  register(type: RoleType, factory: RoleFactory): void {
    this.factories.set(type, factory);
  }

  create(type: RoleType, threadId: string, config: unknown): BaseRole {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`No role factory registered for type ${type}`);
    }

    return factory(threadId, config);
  }
}
