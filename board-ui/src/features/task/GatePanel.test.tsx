import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError, type Approval, type Doc, type Task } from "@factory/core";
import { clearAllUnsent } from "../../lib/unsent";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { GatePanel } from "./GatePanel";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

let task: Task;

async function atSpecGate(): Promise<{ docs: Doc[]; task: Task }> {
  const t = await seedTask({ title: "Gate me" }, "spec_review", { stage: "spec" });
  await fakeBoard().core.addDoc(t.taskId, "spec", "# Spec\nOld scope.\nShared", "spec-agent");
  return { docs: await fakeBoard().owner.listDocs(t.taskId, "spec"), task: t };
}

function renderPanel(docs: Doc[], approvals: Approval[] = [], onReload = vi.fn()) {
  renderWithClient(<GatePanel task={task} gate="spec" docs={docs} approvals={approvals} onReload={onReload} />);
  return { onReload };
}

const comment = () => screen.getByLabelText(/Comment/);

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("GatePanel", () => {
  it("approves_the_version_shown", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    renderPanel(seeded.docs);
    expect(screen.getByText(/Deciding on spec/)).toHaveTextContent("Deciding on spec v1");
    fireEvent.change(comment(), { target: { value: "Looks right" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Approval recorded for spec/)).toHaveTextContent("Approval recorded for spec v1");
    expect(await fakeBoard().owner.listApprovals(task.taskId)).toEqual([
      expect.objectContaining({ comment: "Looks right", decision: "approve", docVersion: 1, gate: "spec" })
    ]);
  });

  it("shows_the_stale_message_and_the_diff_when_the_doc_changed", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    renderPanel(seeded.docs);
    // The agent rewrites the spec while the owner reads v1.
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nNew scope.\nShared", "spec-agent");
    fireEvent.change(comment(), { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The spec changed since you opened it (now v2). Review the new version first.");
    const diff = await screen.findByRole("region", { name: "Spec changes from v1 to v2" });
    expect(within(diff).getByText("− Old scope.")).toBeInTheDocument();
    expect(within(diff).getByText("+ New scope.")).toBeInTheDocument();
    expect(await fakeBoard().owner.listApprovals(task.taskId)).toEqual([]);
    expect(comment()).toHaveValue("Ship it");
    // Reviewing the new version moves the panel to it; approving then records v2.
    fireEvent.click(screen.getByRole("button", { name: "Decide on v2" }));
    expect(screen.getByText(/Deciding on spec/)).toHaveTextContent("Deciding on spec v2");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Approval recorded for spec/)).toHaveTextContent("Approval recorded for spec v2");
  });

  it("keeps_the_comment_on_a_conflict_and_offers_a_reload", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    vi.spyOn(fakeBoard().owner, "addApproval").mockRejectedValueOnce(new VersionConflictError(task.taskId, 1, 2));
    const { onReload } = renderPanel(seeded.docs);
    fireEvent.change(comment(), { target: { value: "Please split the API part" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect(comment()).toHaveValue("Please split the API part");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(comment()).toHaveValue("Please split the API part");
  });

  it("retries_a_click_with_the_same_approval_id", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    const owner = fakeBoard().owner;
    const real = owner.addApproval.bind(owner);
    const spy = vi.spyOn(owner, "addApproval").mockRejectedValueOnce(new Error("blocks: transport error")).mockImplementation(real);
    renderPanel(seeded.docs);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("blocks: transport error");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Approval recorded for spec/)).toHaveTextContent("Approval recorded for spec v1");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0].approvalId).toBeTruthy();
    expect(spy.mock.calls[1]![0].approvalId).toBe(spy.mock.calls[0]![0].approvalId);
  });

  it("needs_a_comment_to_request_changes", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    renderPanel(seeded.docs);
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Say what should change before you request changes.");
    expect(await fakeBoard().owner.listApprovals(task.taskId)).toEqual([]);
  });

  it("shows_the_owner_action_message_when_the_task_moved_on", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    await fakeBoard().core.updateTask(task.taskId, task.version, { status: "plan", stage: "plan" });
    renderPanel(seeded.docs);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`${task.taskId} is not waiting at the spec gate`);
  });

  it("shows_a_decision_already_recorded_for_this_version", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    const approval: Approval = { at: "2026-11-10T09:00:00.000Z", comment: "", decision: "changes", docVersion: 1, gate: "spec", taskId: task.taskId };
    renderPanel(seeded.docs, [approval]);
    expect(screen.getByText(/Changes requested for spec/)).toHaveTextContent("Changes requested for spec v1");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("offers_the_new_version_only_once_its_diff_is_shown", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    const owner = fakeBoard().owner;
    const real = owner.listDocs.bind(owner);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(owner, "listDocs").mockImplementation(async (...args) => { await gate; return real(...args); });
    renderPanel(seeded.docs);
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nNew scope.\nShared", "spec-agent");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Loading v2…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide on v2" })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("region", { name: "Spec changes from v1 to v2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decide on v2" })).toBeInTheDocument();
  });

  it("offers_a_retry_when_the_new_version_cannot_be_loaded", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    vi.spyOn(fakeBoard().owner, "listDocs").mockRejectedValueOnce(new Error("blocks: transport error"));
    renderPanel(seeded.docs);
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nNew scope.\nShared", "spec-agent");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Could not load the spec versions.")).toBeInTheDocument();
    expect(screen.queryByText(/No spec yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide on v2" })).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByRole("region", { name: "Spec changes from v1 to v2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decide on v2" })).toBeInTheDocument();
  });

  it("starts_a_new_round_when_a_new_version_follows_a_recorded_decision", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    const approval: Approval = { at: "2026-11-10T09:00:00.000Z", comment: "split it", decision: "changes", docVersion: 1, gate: "spec", taskId: task.taskId };
    const { client, rerender } = renderWithClient(<GatePanel task={task} gate="spec" docs={seeded.docs} approvals={[approval]} onReload={vi.fn()} />);
    expect(screen.getByText(/Changes requested for spec/)).toBeInTheDocument();
    // The view missed the in-between status: the agent rewrote the spec and the task waits again.
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nNew scope.\nShared", "spec-agent");
    const docs = await fakeBoard().owner.listDocs(task.taskId, "spec");
    rerender(<QueryClientProvider client={client}><GatePanel task={task} gate="spec" docs={docs} approvals={[approval]} onReload={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByText(/Deciding on spec/)).toHaveTextContent("Deciding on spec v2");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("keeps_an_undecided_panel_on_the_version_it_showed", async () => {
    const seeded = await atSpecGate();
    task = seeded.task;
    const { client, rerender } = renderWithClient(<GatePanel task={task} gate="spec" docs={seeded.docs} approvals={[]} onReload={vi.fn()} />);
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nNew scope.\nShared", "spec-agent");
    const docs = await fakeBoard().owner.listDocs(task.taskId, "spec");
    rerender(<QueryClientProvider client={client}><GatePanel task={task} gate="spec" docs={docs} approvals={[]} onReload={vi.fn()} /></QueryClientProvider>);
    expect(screen.getByText(/Deciding on spec/)).toHaveTextContent("Deciding on spec v1");
  });
});
