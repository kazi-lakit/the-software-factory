// Test-only: the Board views over core's real BlocksStore on an in-memory Blocks Data fake.
// Imported by relative path (never through @factory/core, which is the browser entry).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { BoardStore, RepoId, Status, Task } from "@factory/core";
import { BlocksStore } from "../../../core/src/blocks/store";
import { FakeBlocksData, newFakeStorage } from "../../../core/src/blocks/fakeData";
import { blocksFactories, seedBlocksFactories, type Factories } from "./factories";

type FakeBoard = { owner: BlocksStore; core: BlocksStore; ownerData: FakeBlocksData };

let current: FakeBoard | undefined;

/** A fresh shared project: the owner's store (what the page uses) and the core's (to move tasks and write docs). */
export function resetFakeBoard(factories: Factories = blocksFactories()): FakeBoard {
  const storage = newFakeStorage();
  const ownerData = new FakeBlocksData("factory-owner", { storage });
  seedBlocksFactories(ownerData, factories);
  current = {
    core: new BlocksStore(new FakeBlocksData("factory-core", { storage }), "core"),
    owner: new BlocksStore(ownerData, "owner"),
    ownerData
  };
  return current;
}

export function fakeBoard(): FakeBoard {
  if (!current) throw new Error("call resetFakeBoard() first");
  return current;
}

/**
 * Stands in for `boardStore` from lib/board (vi.mock). Each call looks up the current owner store, so a
 * vi.spyOn on `fakeBoard().owner` applies to the page's calls too.
 */
export const proxyBoardStore = new Proxy({} as BoardStore, {
  get(_target, key) {
    const store = fakeBoard().owner as unknown as Record<PropertyKey, unknown>;
    const value = store[key];
    return typeof value === "function" ? value.bind(store) : value;
  }
});

/** Creates a task as the owner, then (as the core) moves it to `status` with the given core fields. */
export async function seedTask(
  input: { title?: string; description?: string; factoryId?: string; repo?: RepoId } = {},
  status: Status = "inbox",
  coreFields: Partial<Task> = {}
): Promise<Task> {
  const { core, owner } = fakeBoard();
  const task = await owner.createTask({ factoryId: input.factoryId ?? "blocks", description: input.description ?? "", repo: input.repo ?? "data", title: input.title ?? "A task" });
  if (status === "inbox" && Object.keys(coreFields).length === 0) return task;
  return core.updateTask(task.taskId, task.version, { status, ...coreFields });
}

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}
