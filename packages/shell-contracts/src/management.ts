import { z } from "zod";
const uuid = z.uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(2000);
export const sampleCatalog = [
  {
    key: "sample-ada",
    name: "Ada Example",
    company: "Example Systems",
    role: "Software Engineer",
    connection: "NotConnected",
  },
  {
    key: "sample-ben",
    name: "Ben Example",
    company: "Example Systems",
    role: "Engineer",
    connection: "Pending",
  },
  {
    key: "sample-cara",
    name: "Cara Example",
    company: "Example Labs",
    role: "Engineer",
    connection: "Connected",
  },
  {
    key: "sample-dev",
    name: "Dev Example",
    company: "",
    role: "Engineer",
    connection: "Unknown",
  },
  {
    key: "sample-emi",
    name: "Emi Example",
    company: "Example Labs",
    role: "Engineer",
    connection: "RejectedConfirmed",
  },
  {
    key: "sample-finn",
    name: "Finn Example",
    company: "Example Labs",
    role: "Engineer",
    connection: "WithdrawnConfirmed",
  },
] as const;
const keys = z
  .array(z.enum(sampleCatalog.map((p) => p.key)))
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Duplicate selection");
const recipients = z
  .array(uuid)
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Duplicate recipients");
export const contentSchema = z.strictObject({
  note: z.string().trim().max(2000),
  firstMessage: text,
  followups: z
    .array(
      z.strictObject({ text, delayDays: z.number().int().min(1).max(365) }),
    )
    .max(3),
});
export const managementRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("import-preview"), keys }),
  z.strictObject({
    operation: z.literal("import"),
    requestId: uuid,
    keys,
    listName: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    operation: z.literal("save-draft"),
    requestId: uuid,
    campaignId: uuid.nullable(),
    revision: revision.nullable(),
    name: z.string().trim().min(1).max(100),
    recipients,
    content: contentSchema,
  }),
  z.strictObject({
    operation: z.literal("approval-preview"),
    campaignId: uuid,
    revision,
  }),
  z.strictObject({
    operation: z.literal("approve"),
    requestId: uuid,
    campaignId: uuid,
    revision,
    preview: z.string().min(1).max(64),
  }),
  z.strictObject({
    operation: z.literal("control"),
    requestId: uuid,
    campaignId: uuid,
    revision,
    action: z.enum(["pause", "resume", "stop"]),
  }),
]);
export type ManagementRequest = z.infer<typeof managementRequestSchema>;
export type Content = z.infer<typeof contentSchema>;
export interface Prospect {
  id: string;
  display_name: string;
  role_title: string | null;
  company: string | null;
  connection: string;
  revision: number;
}
export interface Campaign {
  id: string;
  name: string;
  revision: number;
  status: string;
  content: Content | null;
  recipients: string[];
  approved: boolean;
}
export interface RecipientProgress {
  id: string;
  campaign_id: string;
  prospect_id: string;
  display_name: string;
  status: string;
  stop_reason: string | null;
}
export interface ManagementSnapshot {
  prospects: Prospect[];
  lists: { id: string; name: string; count: number }[];
  campaigns: Campaign[];
  enrollments: RecipientProgress[];
  totalProspects: number;
  totalEnrollments: number;
  page: number;
  sendingEnabled: false;
}
export interface ApprovalPreview {
  fingerprint: string;
  recipients: {
    id: string;
    name: string;
    disposition: string;
    content: Content;
  }[];
}
export const DELETE_CONFIRMATION = "DELETE MY WORKSPACE";
export const deleteWorkspaceSchema = z.strictObject({
  requestId: uuid,
  confirmation: z.literal(DELETE_CONFIRMATION),
});
export type DeleteWorkspaceRequest = z.infer<typeof deleteWorkspaceSchema>;
export const exportSections = [
  "accounts",
  "prospects",
  "lists",
  "memberships",
  "campaigns",
  "revisions",
  "approvals",
  "approvalRecipients",
  "enrollments",
  "actions",
  "attempts",
  "results",
  "observations",
  "reservations",
] as const;
export const EXPORT_FORMAT = "sequence-export-1";
export interface QuotaMeter {
  name: string;
  value: number;
  limit: number;
  percent: number;
  state: "ok" | "warn" | "deny" | "unverified";
  measuredAt: string;
  source: string;
  providerReadingAt: string | null;
  providerVerified: boolean;
}
export interface QuotaStatus {
  checkedAt: string;
  sendingEnabled: false;
  growthAllowed: boolean;
  reasons: string[];
  meters: QuotaMeter[];
  recovery: { state: string; note: string };
  totalProspects: number;
  totalCampaigns: number;
}
export interface DeletionSummary {
  deleted: true;
  workspaceId: string;
  deletedAt: string;
  removed: Record<string, number>;
  unresolvedSends: number;
  backupCutoff: string | null;
  identityRemovalDueBy: string;
  note: string;
  providerConfirmed?: boolean;
}
