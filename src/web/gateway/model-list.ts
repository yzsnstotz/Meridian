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
const LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  gemini: "Gemini",
};

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

function gatewayModelCatalogError(provider: ProviderId, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/No API key configured for provider=(claude|gemini)/i.test(message)) {
    return `${LABELS[provider]} OAuth is connected, but the local CLI did not expose a model catalog.`;
  }
  return message;
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
      errors[provider] = gatewayModelCatalogError(provider, error);
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
