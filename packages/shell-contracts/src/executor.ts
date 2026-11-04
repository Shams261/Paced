import { z } from "zod";
import { PROFILE_KEY_PATTERN } from "./selection-codec.js";
/** Wire contract between a paired browser (executor) and the API. Observation only in this version. */
export const EXECUTOR_CONTRACT = "paced-executor-1";
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
const profilePath = z.string().regex(/^\/in\/[A-Za-z0-9%._-]{1,200}\/?$/);
/** The signed-in LinkedIn identity the extension can see; the server compares it with the bound account. */
export const selfIdentitySchema = z.strictObject({
  profileKey: z.string().regex(PROFILE_KEY_PATTERN).nullable(),
  profilePath: profilePath.nullable(),
});
export const pairRequestSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{8}$/),
  adapterVersion: version,
});
export const heartbeatRequestSchema = z.strictObject({
  adapterVersion: version,
  self: selfIdentitySchema,
});
export const watchlistRequestSchema = z.strictObject({
  self: selfIdentitySchema,
});
/** One message seen in a thread: direction, time and an opaque fingerprint. Never the text. */
export const messageEvidenceSchema = z.strictObject({
  direction: z.enum(["incoming", "outgoing"]),
  at: z.iso.datetime(),
  fingerprint: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
export const executorObservationSchema = z.strictObject({
  prospectId: z.uuid(),
  observedAt: z.iso.datetime(),
  connection: z.enum(["Unknown", "NotConnected", "Pending", "Connected"]),
  complete: z.boolean(),
  messages: z.array(messageEvidenceSchema).max(50).optional(),
  unreadable: z.boolean().optional(),
});
export const observationsRequestSchema = z.strictObject({
  self: selfIdentitySchema,
  observations: z.array(executorObservationSchema).min(1).max(50),
});
export type SelfIdentity = z.infer<typeof selfIdentitySchema>;
export type ExecutorObservation = z.infer<typeof executorObservationSchema>;
export type MessageEvidence = z.infer<typeof messageEvidenceSchema>;
export type ExecutionMode = "disabled" | "observe";
export type IdentityMatch = "match" | "mismatch" | "unknown";
export interface PairResponse {
  token: string;
  executorId: string;
  executionMode: ExecutionMode;
  accountIdentity: string;
}
export interface HeartbeatResponse {
  executorId: string;
  executionMode: ExecutionMode;
  identity: IdentityMatch;
  pollSeconds: number;
}
/** An enrolled person the extension may report on when the user opens that person's page. */
export interface WatchedPerson {
  prospectId: string;
  profilePath: string | null;
  recipientKey: string;
  displayName: string;
  enrolledAt: string;
}
export interface WatchlistResponse {
  executionMode: ExecutionMode;
  identity: IdentityMatch;
  people: WatchedPerson[];
}
export interface ObservationsResponse {
  stored: number;
  duplicates: number;
  rejected: number;
}
