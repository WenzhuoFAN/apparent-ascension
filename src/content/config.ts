import { defineCollection, z } from "astro:content";

const memberEnum = z.enum(["fiona", "gladys", "both"]);

const schedule = defineCollection({
  type: "content",
  schema: z.object({
    weekStart: z.string(), // YYYY-MM-DD (Monday)
    items: z.array(
      z.object({
        startAt: z.string(), // ISO string with timezone
        member: memberEnum,
        title: z.string(),
        type: z.string().optional(),
        link: z.string().url().optional().or(z.literal("")),
      })
    ),
  }),
});

const streams = defineCollection({
  type: "content",
  schema: z.object({
    date: z.string(), // YYYY-MM-DD
    member: memberEnum,
    title: z.string(),
    durationMin: z.number().int().optional(),
    replayUrl: z.string().url().optional().or(z.literal("")),
    highlights: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    relatedClips: z.array(z.string()).default([]),
    relatedFanworks: z.array(z.string()).default([]),
  }),
});

const recBase = z.object({
  title: z.string(),
  author: z.string().optional(),
  url: z.string().url(),
  cover: z.string().url().optional(),
  member: memberEnum,
  platform: z.string().default("bilibili"),
  reason: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().optional(), // YYYY-MM-DD
});

const clips = defineCollection({
  type: "content",
  schema: recBase,
});

const fanworks = defineCollection({
  type: "content",
  schema: recBase,
});

const metricRow = z.object({
  date: z.string(), // YYYY-MM-DD
  capturedAt: z.string().optional(), // ISO datetime
  member: memberEnum,
  followers: z.number().int().nonnegative(),
  note: z.string().optional(),
});

const metrics = defineCollection({
  type: "data",
  schema: z.array(metricRow),
});

export const collections = {
  schedule,
  streams,
  clips,
  fanworks,
  metrics,
};
