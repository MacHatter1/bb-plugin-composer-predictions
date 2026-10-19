import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const stateSchema = z.object({
  threadId: z.string(), sourceKey: z.string().nullable(), generationId: z.string().nullable(),
  status: z.enum(["idle", "generating", "ready", "dismissed", "abstained", "error"]),
  suggestion: z.string().max(240).nullable(), model: z.string().nullable(),
  contextCharacters: z.number(), updatedAt: z.number(), error: z.string().nullable(),
});
export type PredictionState = z.infer<typeof stateSchema>;
export { CHANNEL, MODEL_CHANGED } from "./lib/channels";
export const modelSelectionSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  reasoningLevel: z.string().trim().min(1).max(100),
  serviceTier: z.string().trim().min(1).max(100).optional(),
}).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
const modelSettingsSchema = z.object({ selection: modelSelectionSchema.nullable(), pickerDefault: modelSelectionSchema.nullable(), catalogError: z.string().nullable() });
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
const target = z.object({ threadId: z.string().min(1) });
export const rpcContract = defineRpcContract({
  model_get: { input: z.object({}).strict(), output: modelSettingsSchema },
  model_set: { input: modelSelectionSchema, output: modelSettingsSchema },
  model_clear: { input: z.object({}).strict(), output: modelSettingsSchema },
  get: { input: target, output: stateSchema },
  ensure: { input: target, output: stateSchema },
  regenerate: { input: target, output: stateSchema },
  dismiss: { input: target.extend({ generationId: z.string().nullable() }), output: stateSchema },
});
