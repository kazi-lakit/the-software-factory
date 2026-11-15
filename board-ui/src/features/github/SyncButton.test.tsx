import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATUS_MAP, GITHUB_SCHEMA_MISSING, type SyncResult } from "@factory/core";
import { factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { BoardView } from "../board/BoardView";
import { resetBoardViewForTests } from "../board/useBoardView";
import { resetSelectedFactoryForTests, SELECTED_FACTORY_KEY } from "../factories/useFactories";
import { resetDismissedSyncsForTests } from "./SyncButton";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
vi.mock("../profile/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { firstName: "Ola", lastName: "Owner" } }),
  userDisplayName: (p?: { firstName?: string; lastName?: string }) => (p ? `${p.firstName} ${p.lastName}` : "")
}));

const github = { mode: "connected" as const, project: { owner: "o", number: 3 }, label: "factory", approvers: ["a"], statusMap: DEFAULT_STATUS_MAP };
const render = () => renderWithClient(<BoardView onNavigate={() => {}} />);
const owner = () => fakeBoard().owner;
const SYNC = /^Sync/;

beforeEach(() => { resetFakeBoard(merge(factory("blocks", ["data"], { github }), factory("plain", ["data"], { name: "Plain" }))); resetBoardViewForTests(); resetDismissedSyncsForTests(); resetSelectedFactoryForTests(); window.localStorage.setItem(SELECTED_FACTORY_KEY, "blocks"); });
afterEach(() => { cleanup(); window.localStorage.clear(); resetSelectedFactoryForTests(); vi.restoreAllMocks(); });

const pick = async () => { await screen.findByLabelText("Factory"); };

/** A request the factory machine already planned (empty plan), moved on as the core and the owner would. */
async function row(state: "queued" | "planned" | "applying" | "applied" | "failed", extra: object = {}) {
  const q = await owner().requestSync("blocks", "x");
  if (state === "queued") return q;
  const p = await fakeBoard().core.saveSyncRequest(q, { ...q, state: "planned", plan: { actions: [], notApplied: [], done: [], errors: [] }, plannedAt: "2026-11-15T10:00:00.000Z" });
  if (state === "planned") return p;
  if (state === "failed") return fakeBoard().core.saveSyncRequest(p, { ...p, state: "failed", error: "boom", ...extra });
  const a = await owner().saveSyncRequest(p, { ...p, state: "applying", applyingSince: "2026-11-15T10:00:01.000Z" });
  if (state === "applying") return a;
  return owner().saveSyncRequest(a, { ...a, state: "applied", result: { created: [], applied: [], notApplied: [], errors: [] }, appliedAt: "2026-11-15T10:00:02.000Z", ...extra });
}

describe("Sync with GitHub", () => {
  it("only_a_connected_factory_shows_the_button", async () => {
    render();
    await pick();
    expect(await screen.findByRole("button", { name: SYNC })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Factory"), { target: { value: "plain" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: SYNC })).toBeNull());
    fireEvent.change(screen.getByLabelText("Factory"), { target: { value: "all" } });
    expect(screen.queryByRole("button", { name: SYNC })).toBeNull();
  });

  it("click_queues_a_request_and_shows_waiting", async () => {
    render();
    await pick();
    fireEvent.click(await screen.findByRole("button", { name: SYNC }));
    const waiting = await screen.findByRole("button", { name: "Syncing… (waiting for the factory machine)" });
    expect(waiting).toBeDisabled();
    const rows = await owner().listSyncRequests("blocks");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "queued", requestedBy: "Ola Owner" });
  });

  it("stale_watcher_label_still_queues", async () => {
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    await fakeBoard().core.setFactoryHealth({ checkedAt: old, factoryId: "blocks", ghLoggedIn: true, watcherSeenAt: old });
    render();
    await pick();
    fireEvent.click(await screen.findByRole("button", { name: "Sync with GitHub (factory machine not seen for 2+ minutes)" }));
    await screen.findByRole("button", { name: "Syncing… (waiting for the factory machine)" });
    expect(await owner().listSyncRequests("blocks")).toHaveLength(1);
  });

  it("an_applying_row_says_applying", async () => {
    await row("applying");
    render();
    await pick();
    expect(await screen.findByRole("button", { name: "Syncing… (applying changes)" })).toBeDisabled();
  });

  it("applied_result_lists_created_applied_not_applied_and_failed", async () => {
    const result: SyncResult = {
      created: [{ taskId: "T-5", issue: "o/app#9", status: "ready" }],
      applied: [{ taskId: "T-1", issue: "o/app#2", change: "inbox -> ready" }],
      notApplied: [{ taskId: null, issue: "o/app#3", change: "create", reason: "unknown repo" }],
      errors: [{ taskId: "T-2", issue: null, message: "save failed" }]
    };
    await row("applied", { result });
    render();
    await pick();
    const panel = (await screen.findByRole("heading", { name: /^GitHub sync:/ })).closest("div")!;
    expect(within(panel).getByRole("heading")).toHaveTextContent("GitHub sync: created 1, applied 1, not applied 1, failed 1");
    expect(panel).toHaveTextContent("T-5 created from o/app#9 (ready)");
    expect(panel).toHaveTextContent("T-1 o/app#2: inbox -> ready");
    expect(panel).toHaveTextContent("Not applied - o/app#3: create (unknown repo)");
    expect(panel).toHaveTextContent("Failed T-2 -: save failed");
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/GitHub sync:/)).toBeNull();
  });

  it("failed_row_shows_its_error", async () => {
    await row("failed");
    render();
    await pick();
    expect(await screen.findByText("Sync failed: boom")).toBeInTheDocument();
  });

  it("missing_schema_disables_the_button_with_the_message", async () => {
    // Without the schema the store reads defs without `github`, so the schema flips after the Board loaded the factory.
    let ready = true;
    vi.spyOn(owner(), "githubSchemaReady").mockImplementation(async () => ready);
    const { client } = render();
    await pick();
    await screen.findByRole("button", { name: SYNC });
    ready = false;
    await client.invalidateQueries({ queryKey: ["board", "github-schema"] });
    expect(await screen.findByText(GITHUB_SCHEMA_MISSING)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SYNC })).toBeDisabled();
  });
});
