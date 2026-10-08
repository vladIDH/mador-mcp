import type { AuthenticatedUser } from "../../src/index.js";

/**
 * A fake data layer for an invented analytics SaaS ("Acme Analytics"): each
 * user owns a few projects, each project has weekly metrics. Everything is
 * made up and lives in memory.
 *
 * In your app this is where the real reads go (database, internal API). The
 * shape to keep: the adapter is created FOR one user, and every method reads
 * only that user's rows. A project id of another user is simply not found.
 */

export interface Project {
  id: string;
  name: string;
  website: string;
  createdAt: string;
}

export interface WeeklyMetrics {
  /** Monday of the week, YYYY-MM-DD. */
  week: string;
  visits: number;
  signups: number;
}

export interface ProjectsData {
  listProjects(signal: AbortSignal): Promise<Project[]>;
  getProject(projectId: string, signal: AbortSignal): Promise<Project | null>;
  /** The latest `weeks` weeks, oldest first. */
  getMetrics(projectId: string, weeks: number, signal: AbortSignal): Promise<WeeklyMetrics[]>;
}

interface Row extends Project {
  ownerId: string;
  metrics: WeeklyMetrics[];
}

function weeksOf(startMonday: string, visits: number[], signups: number[]): WeeklyMetrics[] {
  const start = new Date(`${startMonday}T00:00:00Z`).getTime();
  return visits.map((v, i) => ({
    week: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
    visits: v,
    signups: signups[i] ?? 0,
  }));
}

const ROWS: Row[] = [
  {
    id: "prj_bakery",
    ownerId: "user_alice",
    name: "Corner Bakery",
    website: "https://bakery.example",
    createdAt: "2026-03-02",
    metrics: weeksOf("2026-07-06", [820, 870, 910, 1004, 980, 1120, 1190, 1240], [12, 14, 13, 18, 17, 21, 24, 26]),
  },
  {
    id: "prj_shop",
    ownerId: "user_alice",
    name: "Bakery Online Shop",
    website: "https://shop.bakery.example",
    createdAt: "2026-06-15",
    metrics: weeksOf("2026-07-06", [210, 260, 240, 300, 330, 310, 360, 395], [3, 5, 4, 6, 7, 6, 8, 9]),
  },
  {
    id: "prj_yoga",
    ownerId: "user_bob",
    name: "Harbour Yoga Studio",
    website: "https://yoga.example",
    createdAt: "2026-01-20",
    metrics: weeksOf("2026-07-06", [540, 520, 560, 500, 480, 510, 470, 455], [9, 8, 10, 7, 7, 8, 6, 6]),
  },
];

export interface FakeDataOptions {
  /** Simulated latency of every read, in ms. Honours the abort signal. */
  delayMs?: number;
  /** Makes every read fail with this error, to see how failures look. */
  failWith?: Error;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const publicPart = ({ id, name, website, createdAt }: Row): Project => ({ id, name, website, createdAt });

export function fakeData(user: AuthenticatedUser, options: FakeDataOptions = {}): ProjectsData {
  const mine = () => ROWS.filter((r) => r.ownerId === user.userId);
  const read = async <T>(signal: AbortSignal, f: () => T): Promise<T> => {
    await wait(options.delayMs ?? 0, signal);
    if (options.failWith) throw options.failWith;
    return f();
  };
  return {
    listProjects: (signal) => read(signal, () => mine().map(publicPart)),
    getProject: (projectId, signal) =>
      read(signal, () => {
        const row = mine().find((r) => r.id === projectId);
        return row ? publicPart(row) : null;
      }),
    getMetrics: (projectId, weeks, signal) =>
      read(signal, () => mine().find((r) => r.id === projectId)?.metrics.slice(-weeks) ?? []),
  };
}
