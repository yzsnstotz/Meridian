import {
  ProviderCapabilitySchema,
  ProviderCapabilityListSchema,
  type AgentType,
  type ProviderCapability,
  type ProviderCapabilityList
} from "../types";

const providerCapabilityMap = {
  codex: {
    supports_ads_safe: true,
    supports_read_only: true,
    supports_images: false,
    supports_text_files: true,
    supports_pdf: false,
    supports_stream_safe: true
  },
  claude: {
    supports_ads_safe: true,
    supports_read_only: true,
    supports_images: true,
    supports_text_files: true,
    supports_pdf: true,
    supports_stream_safe: true
  },
  gemini: {
    supports_ads_safe: false,
    supports_read_only: false,
    supports_images: false,
    supports_text_files: false,
    supports_pdf: false,
    supports_stream_safe: false
  }
} as const;

const supportedProviderCapabilityTypes = Object.keys(providerCapabilityMap) as Array<keyof typeof providerCapabilityMap>;

export function getProviderCapabilities(agentType: AgentType): ProviderCapability {
  const capabilityEntry = providerCapabilityMap[agentType as keyof typeof providerCapabilityMap];
  if (!capabilityEntry) {
    throw new Error(`No provider capabilities configured for agent_type=${agentType}`);
  }
  return ProviderCapabilitySchema.parse({
    agent_type: agentType,
    ...capabilityEntry
  });
}

export function listProviderCapabilities(): ProviderCapabilityList {
  return ProviderCapabilityListSchema.parse(
    supportedProviderCapabilityTypes.map((agentType) => getProviderCapabilities(agentType))
  );
}
