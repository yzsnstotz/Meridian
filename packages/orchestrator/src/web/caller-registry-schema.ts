import { z } from "zod";

const CallerIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/);

export const HmacCallerSchema = z
  .object({
    caller_id: CallerIdSchema,
    auth_method: z.literal("hmac"),
    hmac_key_env: z.string().min(1),
    mtls_cert_thumbprint: z.never().optional(),
    allowed_project_ids: z.array(z.string().min(1))
  })
  .strict();

export const MtlsCallerSchema = z
  .object({
    caller_id: CallerIdSchema,
    auth_method: z.literal("mtls"),
    hmac_key_env: z.never().optional(),
    mtls_cert_thumbprint: z.string().min(1),
    allowed_project_ids: z.array(z.string().min(1))
  })
  .strict();

export const CallerRegistrySchema = z.discriminatedUnion("auth_method", [HmacCallerSchema, MtlsCallerSchema]);

export type CallerRegistryEntry = z.infer<typeof CallerRegistrySchema>;
export type HmacCallerEntry = z.infer<typeof HmacCallerSchema>;
export type MtlsCallerEntry = z.infer<typeof MtlsCallerSchema>;
export type CallerRegistry = ReadonlyMap<string, CallerRegistryEntry>;
