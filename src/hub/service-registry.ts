import { ServiceEndpointSchema, type ServiceEndpoint } from "../types";

export class ServiceRegistry {
  private readonly endpointsByService = new Map<string, ServiceEndpoint>();
  private readonly serviceByIntent = new Map<string, string>();

  register(rawEndpoint: ServiceEndpoint): ServiceEndpoint {
    const endpoint = ServiceEndpointSchema.parse(rawEndpoint);
    const serviceId = endpoint.service ?? endpoint.socket_path;
    this.unregister(serviceId);

    this.endpointsByService.set(serviceId, endpoint);
    for (const intent of endpoint.intents) {
      this.serviceByIntent.set(intent, serviceId);
    }
    return endpoint;
  }

  unregister(serviceId: string): boolean {
    const existing = this.endpointsByService.get(serviceId);
    if (!existing) {
      return false;
    }

    this.endpointsByService.delete(serviceId);
    for (const intent of existing.intents) {
      if (this.serviceByIntent.get(intent) === serviceId) {
        this.serviceByIntent.delete(intent);
      }
    }
    return true;
  }

  resolve(intent: string): ServiceEndpoint | null {
    const serviceId = this.serviceByIntent.get(intent);
    if (!serviceId) {
      return null;
    }
    return this.endpointsByService.get(serviceId) ?? null;
  }

  list(): ServiceEndpoint[] {
    return Array.from(this.endpointsByService.values(), (endpoint) => ({
      ...endpoint,
      intents: [...endpoint.intents],
      metadata: endpoint.metadata ? { ...endpoint.metadata } : undefined
    }));
  }
}
