import { ToolError, defineReadOnlyTool, type ToolContext } from "../../src/index.js";
import type { Project, ProjectsData } from "./data.js";

/**
 * Three read-only tools over the fake data layer. Names and descriptions are
 * in English because a model reads them; the data stays as it is.
 */

export const INSTRUCTIONS = [
  "Acme Analytics tracks visits and signups for the websites of the signed-in account.",
  "This server is read-only: nothing here changes any data.",
  "Start with list_projects. When the account has a single project, project_id can be omitted.",
  "Answer in the user's language and keep project names exactly as they appear in the data.",
].join(" ");

const PROJECT_ID = {
  type: "object",
  properties: {
    project_id: {
      type: "string",
      description: "The project id from list_projects. Optional when the account has exactly one project.",
    },
  },
  additionalProperties: false,
} as const;

/** The project of the call: the given id, or the only one. Never another user's. */
async function projectOf(ctx: ToolContext<ProjectsData>, id: unknown): Promise<Project> {
  const all = await ctx.data.listProjects(ctx.signal);
  if (all.length === 0) throw new ToolError("This account has no projects yet.");
  if (typeof id === "string" && id.trim() !== "") {
    const found = all.find((p) => p.id === id.trim());
    if (!found) throw new ToolError("Project not found in this account. Call list_projects to get the valid project ids.");
    return found;
  }
  if (all.length === 1) return all[0]!;
  throw new ToolError(`This account has ${all.length} projects: pass project_id. ${all.map((p) => `${p.name} = ${p.id}`).join("; ")}.`);
}

const pct = (from: number, to: number): string =>
  from === 0 ? "n/a" : `${to >= from ? "+" : ""}${Math.round(((to - from) / from) * 100)}%`;

export const listProjects = defineReadOnlyTool<ProjectsData>({
  name: "list_projects",
  title: "List projects",
  description:
    "Lists the projects (websites) of this account: id, name, website and creation date. Call this first to get the project_id used by the other tools.",
  handler: async (_args, ctx) => {
    const projects = await ctx.data.listProjects(ctx.signal);
    const text =
      projects.length === 0
        ? "No projects yet."
        : [
            `${projects.length} ${projects.length === 1 ? "project" : "projects"}:`,
            ...projects.map((p) => `- ${p.name} (project_id ${p.id}): ${p.website}, created ${p.createdAt}.`),
          ].join("\n");
    return { text, data: { projects } };
  },
});

export const getProject = defineReadOnlyTool<ProjectsData, { project_id?: unknown }>({
  name: "get_project",
  title: "How a project is doing",
  description:
    "The latest week of one project in plain words: visits, signups, conversion rate, and the change against the week before. Use it to answer «how is my site doing?».",
  inputSchema: PROJECT_ID,
  handler: async (args, ctx) => {
    const project = await projectOf(ctx, args.project_id);
    const [prev, last] = await ctx.data.getMetrics(project.id, 2, ctx.signal);
    if (!last) return { text: `${project.name}: no data yet.`, data: { project, latest_week: null, previous_week: null } };
    const conversion = (w: { visits: number; signups: number }) => (w.visits ? Math.round((w.signups / w.visits) * 1000) / 10 : 0);
    const lines = [
      `${project.name}, week of ${last.week}: ${last.visits} visits, ${last.signups} signups (conversion ${conversion(last)}%).`,
      prev
        ? `Against the week of ${prev.week}: visits ${pct(prev.visits, last.visits)}, signups ${pct(prev.signups, last.signups)}.`
        : "No previous week to compare with.",
    ];
    return {
      text: lines.join("\n"),
      data: {
        project,
        latest_week: { ...last, conversion_percent: conversion(last) },
        previous_week: prev ? { ...prev, conversion_percent: conversion(prev) } : null,
      },
    };
  },
});

export const getMetrics = defineReadOnlyTool<ProjectsData, { project_id?: unknown; weeks?: unknown }>({
  name: "get_metrics",
  title: "Weekly metrics",
  description: "Visits and signups of one project, week by week, oldest first. Up to 26 weeks; default 8.",
  inputSchema: {
    type: "object",
    properties: {
      ...PROJECT_ID.properties,
      weeks: { type: "integer", minimum: 1, maximum: 26, description: "How many weeks, counting back from the latest. Default 8." },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const project = await projectOf(ctx, args.project_id);
    const weeks = typeof args.weeks === "number" ? Math.min(26, Math.max(1, Math.floor(args.weeks))) : 8;
    const rows = await ctx.data.getMetrics(project.id, weeks, ctx.signal);
    const text =
      rows.length === 0
        ? `${project.name}: no data yet.`
        : [`${project.name}, last ${rows.length} weeks:`, ...rows.map((r) => `- ${r.week}: ${r.visits} visits, ${r.signups} signups`)].join("\n");
    return { text, data: { project, weeks: rows } };
  },
});

export const TOOLS = [listProjects, getProject, getMetrics];
