import { describe, expect, it } from "vitest";
import { emptyPushed, type GitHubLink, type Task } from "@factory/core";
import { defFixture } from "../../test/factories";
import { cardGitHub, issueUrl, STUCK_ATTEMPTS } from "./githubCard";

const task = (patch: Partial<Task> = {}): Task => ({
  answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0,
  description: "", factoryId: "blocks", gateOverrides: {}, dependsOn: [], prUrl: null, question: null, repo: "data", stage: null, status: "ready",
  taskId: "T-7", title: "Add a filter", version: 1, ...patch
});
const link = (patch: Partial<GitHubLink> = {}): GitHubLink => ({
  taskId: "T-7", factoryId: "blocks", repo: "acme/app", issueNumber: 12, issueNodeId: null, project: null, itemId: null,
  pushed: emptyPushed(), error: null, lease: null, reported: [], version: 1, ...patch
});
const github = { mode: "connected" as const, project: { owner: "o", number: 3 }, label: "factory", approvers: ["a"], statusMap: {} as never };
const connected = defFixture("blocks", { github });
const failing = (attempts: number) => ({ message: "rate limited", attempts, nextAttemptAt: "2026-11-15T10:00:00.000Z" });

describe("cardGitHub", () => {
  it("connected with an issue gives #n and the URL", () => {
    expect(cardGitHub(task(), link(), connected)).toEqual({
      issue: { label: "#12", name: "acme/app#12", url: "https://github.com/acme/app/issues/12" }, waiting: false, error: null
    });
    expect(issueUrl("acme/app", 12)).toBe("https://github.com/acme/app/issues/12");
  });

  it("connected without a link is waiting; a done task without a link is nothing", () => {
    expect(cardGitHub(task(), undefined, connected)).toEqual({ issue: null, waiting: true, error: null });
    expect(cardGitHub(task(), link({ issueNumber: null }), connected)).toMatchObject({ issue: null, waiting: true });
    expect(cardGitHub(task({ status: "done" }), undefined, connected)).toBeNull();
    expect(cardGitHub(task({ status: "cancelled" }), undefined, connected)).toBeNull();
  });

  it("two failures are not stuck; three show the error, with the issue kept", () => {
    expect(STUCK_ATTEMPTS).toBe(3);
    expect(cardGitHub(task(), link({ error: failing(2) }), connected)?.error).toBeNull();
    const stuck = cardGitHub(task(), link({ error: failing(3) }), connected);
    expect(stuck?.error).toBe("rate limited");
    expect(stuck?.issue?.label).toBe("#12");
  });

  it("a factory without github or github-only gives null", () => {
    expect(cardGitHub(task(), link(), defFixture("blocks"))).toBeNull();
    expect(cardGitHub(task(), link(), defFixture("blocks", { github: { ...github, mode: "github-only" } }))).toBeNull();
    expect(cardGitHub(task(), link(), undefined)).toBeNull();
  });
});
