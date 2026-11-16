import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATUS_MAP, VersionConflictError, type PullAction } from "@factory/core";
import { factory } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { BoardView } from "../board/BoardView";
import { resetBoardViewForTests } from "../board/useBoardView";
import { resetSelectedFactoryForTests, SELECTED_FACTORY_KEY } from "../factories/useFactories";
import { resetDismissedSyncsForTests } from "./SyncButton";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
vi.mock("../profile/useCurrentUser", () => ({ useCurrentUser: () => ({ data: undefined }), userDisplayName: () => "" }));

const github = { mode: "connected" as const, project: { owner: "o", number: 3 }, label: "factory", approvers: ["a"], statusMap: DEFAULT_STATUS_MAP };
const owner = () => fakeBoard().owner;
const create: PullAction = { kind: "create", issue: { repo: "o/app", number: 9 }, nodeId: "I", itemId: "P", option: null, labelled: true, repoId: "data", baseBranch: "dev", title: "From GitHub", description: "d", status: "inbox" };
const block: PullAction = { kind: "block", taskId: "T-1", version: 1, issue: { repo: "o/app", number: 2 }, reason: "label removed" };

beforeEach(() => { resetFakeBoard(factory("blocks", ["data"], { github })); resetBoardViewForTests(); resetDismissedSyncsForTests(); resetSelectedFactoryForTests(); window.localStorage.setItem(SELECTED_FACTORY_KEY, "blocks"); });
afterEach(() => { cleanup(); window.localStorage.clear(); resetSelectedFactoryForTests(); vi.restoreAllMocks(); });

async function planned(actions: PullAction[]) {
  const q = await owner().requestSync("blocks", "x");
  return fakeBoard().core.saveSyncRequest(q, { ...q, state: "planned", plan: { actions, notApplied: [], done: [], errors: [] }, plannedAt: "2026-11-15T10:00:00.000Z" });
}
const render = () => renderWithClient(<BoardView onNavigate={() => {}} />);

describe("usePendingSyncs", () => {
  it("a planned row is applied on mount", async () => {
    await planned([create]);
    render();
    expect(await screen.findByText("From GitHub")).toBeInTheDocument();
    const [r] = await owner().listSyncRequests("blocks");
    expect(r).toMatchObject({ state: "applied" });
    expect(r!.result!.created).toHaveLength(1);
  });

  it("a row is applied once even when the query refetches", async () => {
    await planned([create]);
    const spy = vi.spyOn(owner(), "saveSyncRequest");
    const { client } = render();
    await screen.findByText("From GitHub");
    await client.invalidateQueries({ queryKey: ["board", "github-sync", "blocks"] });
    await client.invalidateQueries({ queryKey: ["board", "github-sync", "blocks"] });
    expect(spy.mock.calls.filter(([, after]) => after.state === "applying")).toHaveLength(1);
    expect((await owner().listTasks()).filter((t) => t.title === "From GitHub")).toHaveLength(1);
  });

  it("a block action in a planned row is reported as not applied, not run", async () => {
    await planned([block]);
    render();
    await waitFor(async () => expect((await owner().listSyncRequests("blocks"))[0]!.state).toBe("applied"));
    const [r] = await owner().listSyncRequests("blocks");
    expect(r!.result!.notApplied).toMatchObject([{ change: "block", reason: "the factory machine applies this" }]);
    expect(await screen.findByText(/Not applied T-1 o\/app#2: block \(the factory machine applies this\)/)).toBeInTheDocument();
  });

  it("a claim lost to another tab applies nothing and shows no error", async () => {
    const row = await planned([create]);
    // Another tab claims first: our save of planned->applying conflicts.
    const real = owner().saveSyncRequest.bind(owner());
    vi.spyOn(owner(), "saveSyncRequest").mockImplementation(async (before, after) => {
      if (after.state === "applying") throw new VersionConflictError(row.requestId, 1, 2);
      return real(before, after);
    });
    render();
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((await owner().listTasks()).filter((t) => t.title === "From GitHub")).toHaveLength(0);
  });

  it("a claim that fails with a non-conflict error is tried again on the next poll", async () => {
    await planned([create]);
    const real = owner().saveSyncRequest.bind(owner());
    let fail = true;
    vi.spyOn(owner(), "saveSyncRequest").mockImplementation(async (before, after) => {
      if (after.state === "applying" && fail) { fail = false; throw new Error("network down"); }
      return real(before, after);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = render();
    await waitFor(() => expect(fail).toBe(false));
    await new Promise((r) => setTimeout(r, 50));
    expect((await owner().listSyncRequests("blocks"))[0]!.state).toBe("planned");
    await client.invalidateQueries({ queryKey: ["board", "github-sync", "blocks"] });
    expect(await screen.findByText("From GitHub")).toBeInTheDocument();
    expect((await owner().listSyncRequests("blocks"))[0]!.state).toBe("applied");
  });

  it("losing the final applied save to a stale failure is a refresh, not an error", async () => {
    await planned([create]);
    const real = owner().saveSyncRequest.bind(owner());
    vi.spyOn(owner(), "saveSyncRequest").mockImplementation(async (before, after) => {
      if (after.state === "applied") {
        // Another tab failed the row as stale meanwhile.
        await fakeBoard().core.saveSyncRequest(before, { ...before, state: "failed", error: "interrupted while applying; click Sync again" });
      }
      return real(before, after);
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render();
    await waitFor(async () => expect((await owner().listSyncRequests("blocks"))[0]!.state).toBe("failed"));
    expect(await screen.findByText("Sync failed: interrupted while applying; click Sync again")).toBeInTheDocument();
    expect(err).not.toHaveBeenCalled();
  });
});
