import type { ProviderModelCatalogResult } from "../../shared/model-catalog";
import type { AgentType, ProviderModel } from "../../types";
import type { ProvidersStatus, ProviderId } from "./login";

export interface GatewayModel {
  id: string;
  object: "model";
  owned_by: string;
}

export interface GatewayModelList {
  object: "list";
  data: GatewayModel[];
  errors?: Partial<Record<ProviderId, string>>;
}

export interface GatewayModelCatalog {
  listModels(provider: AgentType): Promise<ProviderModelCatalogResult>;
}

const PROVIDERS: ProviderId[] = ["claude", "codex", "gemini"];

export function ownerForProvider(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "anthropic-subscription";
    case "codex":
      return "openai-subscription";
    case "gemini":
      return "gemini-subscription";
  }
}

function modelToGateway(provider: ProviderId, model: ProviderModel): GatewayModel {
  return {
    id: model.id,
    object: "model",
    owned_by: ownerForProvider(provider)
  };
}

export async function listGatewayModels(
  status: ProvidersStatus,
  catalog: GatewayModelCatalog
): Promise<GatewayModelList> {
  const data: GatewayModel[] = [];
  const errors: Partial<Record<ProviderId, string>> = {};

  for (const provider of PROVIDERS) {
    if (!status[provider]?.connected) continue;
    try {
      const result = await catalog.listModels(provider);
      data.push(...result.models.map((model) => modelToGateway(provider, model)));
    } catch (error) {
      errors[provider] = error instanceof Error ? error.message : String(error);
    }
  }

  const sorted = data.sort((left, right) => {
    const ownerCompare = left.owned_by.localeCompare(right.owned_by);
    return ownerCompare === 0 ? left.id.localeCompare(right.id) : ownerCompare;
  });
  return Object.keys(errors).length > 0
    ? { object: "list", data: sorted, errors }
    : { object: "list", data: sorted };
}
