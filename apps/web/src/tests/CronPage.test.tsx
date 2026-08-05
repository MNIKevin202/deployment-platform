import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CronPage from "../pages/CronPage";
import type { CronJob, CronJobRun, StoredApp } from "../types/api";

function app(id: number, name: string): StoredApp {
  return {
    id,
    name,
    containerId: "c",
    containerName: `app-${name}`,
    image: "nginx:alpine",
    containerPort: 80,
    domain: null,
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    lastDeployedAt: null,
    routingReady: true,
    health: null,
    latestEventSeverity: null
  } as StoredApp;
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 1,
    appId: 10,
    appName: "web",
    containerName: "app-web",
    name: "Nightly cleanup",
    cronExpression: "0 3 * * *",
    command: "php artisan cleanup",
    enabled: true,
    timeoutSeconds: 300,
    lastRunAt: null,
    lastStatus: null,
    lastExitCode: null,
    lastOutput: null,
    lastDurationMs: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

interface Calls {
  posts: Array<{ url: string; body: unknown }>;
  puts: Array<{ url: string; body: unknown }>;
  deletes: string[];
}

function run(overrides: Partial<CronJobRun> = {}): CronJobRun {
  return {
    id: 1,
    cronJobId: 1,
    status: "success",
    exitCode: 0,
    output: "cleaned 42 rows",
    durationMs: 1200,
    ranAt: "2026-08-01T03:00:00Z",
    createdAt: "2026-08-01T03:00:00Z",
    ...overrides
  };
}

function stubFetch(options: {
  jobs?: CronJob[];
  preview?: { valid: boolean; description?: string; error?: string };
  runs?: CronJobRun[];
}): Calls {
  const calls: Calls = { posts: [], puts: [], deletes: [] };
  let jobs = options.jobs ?? [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      if (url === "/api/cron-jobs/preview") {
        const preview = options.preview ?? { valid: true, description: "Every day at 3:00 AM" };
        return json({ success: true, ...preview });
      }
      if (url.match(/\/api\/cron-jobs\/\d+\/runs$/) && method === "GET") {
        return json({ success: true, runs: options.runs ?? [] });
      }
      if (url === "/api/cron-jobs" && method === "GET") {
        return json({ success: true, jobs });
      }
      if (url === "/api/cron-jobs" && method === "POST") {
        calls.posts.push({ url, body });
        jobs = [...jobs, job({ ...(body as object), id: 99 } as Partial<CronJob>)];
        return json({ success: true, job: jobs[jobs.length - 1] }, 201);
      }
      if (url.match(/\/api\/cron-jobs\/\d+$/) && method === "PUT") {
        calls.puts.push({ url, body });
        return json({ success: true, job: job(body as Partial<CronJob>) });
      }
      if (url.match(/\/api\/cron-jobs\/\d+$/) && method === "DELETE") {
        calls.deletes.push(url);
        jobs = jobs.filter((j) => !url.endsWith(`/${j.id}`));
        return json({ success: true });
      }
      if (url.match(/\/api\/cron-jobs\/\d+\/run$/)) {
        calls.posts.push({ url, body });
        return json({ success: true, result: { status: "success" } });
      }
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    })
  );

  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("CronPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("lists existing jobs with schedule and command", async () => {
    stubFetch({ jobs: [job()] });
    render(<CronPage apps={[app(10, "web")]} />);

    expect(await screen.findByText("Nightly cleanup")).toBeInTheDocument();
    expect(screen.getByText("php artisan cleanup")).toBeInTheDocument();
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument();
  });

  test("shows an empty state when there are no jobs", async () => {
    stubFetch({ jobs: [] });
    render(<CronPage apps={[app(10, "web")]} />);
    expect(await screen.findByText("No cron jobs yet.")).toBeInTheDocument();
  });

  test("blocks creating a job when there are no apps", async () => {
    stubFetch({ jobs: [] });
    render(<CronPage apps={[]} />);
    await screen.findByText("No cron jobs yet.");
    expect(screen.getByRole("button", { name: "New Cron Job" })).toBeDisabled();
    expect(screen.getByText(/Create an app first/)).toBeInTheDocument();
  });

  test("creating a job posts the app, command, and schedule", async () => {
    const calls = stubFetch({ jobs: [] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web"), app(11, "api")]} />);

    await screen.findByText("No cron jobs yet.");
    await user.click(screen.getByRole("button", { name: "New Cron Job" }));

    await user.type(screen.getByPlaceholderText("Nightly cleanup"), "Backup");
    await user.type(screen.getByPlaceholderText("php artisan schedule:run"), "pg_dump app");
    // Schedule defaults to 0 3 * * *. Wait for the live preview to validate.
    await screen.findByText("Every day at 3:00 AM");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls.posts.length).toBeGreaterThan(0));
    const created = calls.posts[0].body as Record<string, unknown>;
    expect(created.appId).toBe(10);
    expect(created.command).toBe("pg_dump app");
    expect(created.cronExpression).toBe("0 3 * * *");
    expect(created.name).toBe("Backup");
  });

  test("an invalid cron expression disables Create and shows the error", async () => {
    stubFetch({ jobs: [], preview: { valid: false, error: "minute must be 0–59" } });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("No cron jobs yet.");
    await user.click(screen.getByRole("button", { name: "New Cron Job" }));
    await user.type(screen.getByPlaceholderText("Nightly cleanup"), "Bad");
    await user.type(screen.getByPlaceholderText("php artisan schedule:run"), "echo");

    expect(await screen.findByText("minute must be 0–59")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  test("a schedule preset fills the cron field", async () => {
    stubFetch({ jobs: [] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("No cron jobs yet.");
    await user.click(screen.getByRole("button", { name: "New Cron Job" }));
    await user.click(screen.getByRole("button", { name: "Hourly" }));

    expect((screen.getByPlaceholderText("0 3 * * *") as HTMLInputElement).value).toBe("0 * * * *");
  });

  test("Run now posts to the run endpoint", async () => {
    const calls = stubFetch({ jobs: [job()] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    await user.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() =>
      expect(calls.posts.some((p) => p.url.endsWith("/run"))).toBe(true)
    );
  });

  test("toggling enabled sends a PUT with the flipped value", async () => {
    const calls = stubFetch({ jobs: [job({ enabled: true })] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    const row = screen.getByText("Nightly cleanup").closest("tr") as HTMLElement;
    // The enabled control is a role="switch" button (not a bare checkbox), so
    // it exposes its on/off state via aria-checked.
    const toggle = within(row).getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);

    await waitFor(() => expect(calls.puts.length).toBeGreaterThan(0));
    expect((calls.puts[0].body as { enabled: boolean }).enabled).toBe(false);
  });

  test("deleting a job asks for confirmation then sends DELETE", async () => {
    const calls = stubFetch({ jobs: [job()] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    // The row's Delete opens the confirm dialog.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/It will stop running on its schedule/)).toBeInTheDocument();

    // Now two "Delete" buttons exist (row + dialog); the dialog's is the
    // confirm action — click the last one.
    const deletes = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deletes[deletes.length - 1]);
    await waitFor(() => expect(calls.deletes.length).toBeGreaterThan(0));
  });

  test("clicking a last-run status opens the run history with the newest output", async () => {
    stubFetch({
      jobs: [
        job({
          lastRunAt: "2026-08-01T03:00:00Z",
          lastStatus: "success",
          lastExitCode: 0,
          lastOutput: "cleaned 42 rows",
          lastDurationMs: 1200
        })
      ],
      runs: [run({ output: "cleaned 42 rows" })]
    });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    await user.click(screen.getByRole("button", { name: /success/ }));

    expect(await screen.findByRole("heading", { name: "Nightly cleanup" })).toBeInTheDocument();
    expect(await screen.findByText("cleaned 42 rows")).toBeInTheDocument();
  });

  test("run history lists multiple runs and switches output on click", async () => {
    stubFetch({
      jobs: [
        job({
          lastRunAt: "2026-08-01T03:05:00Z",
          lastStatus: "failed",
          lastExitCode: 1,
          lastOutput: "boom",
          lastDurationMs: 900
        })
      ],
      runs: [
        run({ id: 2, status: "failed", exitCode: 1, output: "boom", ranAt: "2026-08-01T03:05:00Z" }),
        run({ id: 1, status: "success", exitCode: 0, output: "all good", ranAt: "2026-08-01T03:00:00Z" })
      ]
    });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    // Open history from the last-run status (failed).
    await user.click(screen.getByRole("button", { name: /failed/ }));

    // Newest run's output shows by default.
    expect(await screen.findByText("boom")).toBeInTheDocument();

    // Selecting the older, successful run switches the shown output.
    const successRun = await screen.findByRole("button", { name: /success/ });
    await user.click(successRun);
    expect(await screen.findByText("all good")).toBeInTheDocument();
  });

  test("run history shows an empty state when a job hasn't run", async () => {
    stubFetch({ jobs: [job({ lastRunAt: "2026-08-01T03:00:00Z", lastStatus: "skipped" })], runs: [] });
    const user = userEvent.setup();
    render(<CronPage apps={[app(10, "web")]} />);

    await screen.findByText("Nightly cleanup");
    await user.click(screen.getByRole("button", { name: /skipped/ }));

    expect(await screen.findByText("This job hasn't run yet.")).toBeInTheDocument();
  });
});
