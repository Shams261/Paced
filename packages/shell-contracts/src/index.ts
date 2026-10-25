import { z } from "zod";
import {
  connectionSchema,
  type EnrollmentStatus,
} from "@outreach/campaign-engine";
const enrollmentValues = [
  "Active",
  "Waiting",
  "Paused",
  "Held",
  "Stopped",
  "Completed",
] as const satisfies readonly EnrollmentStatus[];
export const snapshotSchema = z.strictObject({
  source: z.literal("SYN"),
  liveSending: z.literal(false),
  prospects: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      company: z.string(),
      initials: z.string(),
      list: z.string(),
      connection: connectionSchema,
    }),
  ),
  campaigns: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      status: z.enum(["Draft", "Paused"]),
      prospects: z.number().int().nonnegative(),
      steps: z.number().int().positive(),
    }),
  ),
  queue: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      campaign: z.string(),
      step: z.string(),
      status: z.enum(enrollmentValues),
      reason: z.string(),
    }),
  ),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
