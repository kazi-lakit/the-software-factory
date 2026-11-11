import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksFactories, defFixture, factory, merge, repoFixture } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { FACTORIES_KEY } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { NewFactoryPage } from "./NewFactoryPage";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const owner = () => fakeBoard().owner;
const changeField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const importJson = () =>
  JSON.stringify({ factory: defFixture("blocks", { name: "Blocks" }), format: "factory-import/1", repos: [repoFixture("blocks", "data"), repoFixture("blocks", "os")] });

function renderPage() {
  const onNavigate = vi.fn();
  const view = renderWithClient(<NewFactoryPage onNavigate={onNavigate} />);
  return { ...view, onNavigate };
}

const form = () => screen.getByRole("form", { name: "New factory" });
const summary = () => screen.getByRole("complementary", { name: "Summary" });
const chips = () => within(screen.getByRole("list", { name: "Protected branches" })).getAllByRole("listitem").map((li) => li.querySelector("span")?.textContent);
const footerText = (name: string) => `${name} starts with the global gates and limits; change them in Settings.`;

beforeEach(() => {
  resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"], { name: "Delta" })));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("New factory page", () => {
  it("shows_the_breadcrumb_h1_and_two_tabs_with_set_it_up_first", () => {
    const { onNavigate } = renderPage();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Settings / Factories / New factory");
    const settings = within(crumbs).getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/settings");
    fireEvent.click(settings);
    expect(onNavigate).toHaveBeenCalledWith("/settings");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New factory");
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Set it up", "Import from a file"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("factories_crumb_goes_to_the_settings_factories_section", () => {
    const { onNavigate } = renderPage();
    const crumb = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Factories" });
    expect(crumb).toHaveAttribute("href", "/settings#settings-factories");
    fireEvent.click(crumb);
    expect(onNavigate).toHaveBeenCalledWith("/settings#settings-factories");
  });

  it("keeps_the_draft_when_switching_tabs_and_back", () => {
    renderPage();
    changeField("Name", "Echo");
    changeField("GitHub login", "octocat");
    fireEvent.click(screen.getByRole("button", { name: "Remove dev" }));
    changeField("Add a branch", "rel");
    fireEvent.click(screen.getByRole("tab", { name: "Import from a file" }));
    fireEvent.click(screen.getByRole("tab", { name: "Set it up" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Echo");
    expect(screen.getByLabelText("Factory id")).toHaveValue("echo");
    expect(screen.getByLabelText("GitHub login")).toHaveValue("octocat");
    expect(screen.getByLabelText("Add a branch")).toHaveValue("rel");
    expect(chips()).toEqual(["stg", "main"]);
    // The id still follows the name: it was never edited.
    changeField("Name", "Echo Two");
    expect(screen.getByLabelText("Factory id")).toHaveValue("echo-two");
  });

  it("keeps_create_disabled_after_a_save_until_the_page_leaves", async () => {
    const { client, onNavigate } = renderPage();
    // A refetch that never settles: the page stays up after the save.
    vi.spyOn(client, "invalidateQueries").mockReturnValue(new Promise<void>(() => {}));
    const save = vi.spyOn(owner(), "saveFactoryDef");
    changeField("Name", "Echo");
    const create = within(form()).getByRole("button", { name: "Create factory" });
    fireEvent.click(create);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(create).toBeDisabled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).toBeDisabled();
    fireEvent.click(create);
    fireEvent.submit(form());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledTimes(1);
    expect(within(form()).queryByRole("alert")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("has_the_four_h2_sections_with_their_hints_tied_by_aria_describedby", () => {
    renderPage();
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    for (const name of ["Name it", "GitHub", "Protected branches", "Background reading"]) expect(h2s).toContain(name);
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Shown on the Board and in the factory filter.");
    expect(screen.getByLabelText("Factory id")).toHaveAccessibleDescription("Lowercase letters, digits and hyphens, starting with a letter. It can't change later.");
    expect(screen.getByLabelText("GitHub login")).toHaveAccessibleDescription(
      "The gh account the factory opens PRs with. Run gh auth login on this Mac first; the Board stores the login, never a token."
    );
    expect(screen.getByLabelText("Commit email")).toHaveAccessibleDescription("Used on every commit the factory makes.");
    expect(screen.getByLabelText("Docs folder")).toHaveAccessibleDescription("The spec writer reads each repo's overview here. Read only: nothing in the factory writes to it.");
    expect(screen.getByLabelText("Commit name")).toBeInTheDocument();
    expect(screen.getByText("The factory never pushes to these. Work reaches them only through a PR you merge.")).toBeInTheDocument();
  });

  it("fills_the_id_from_the_name_until_the_id_is_edited", () => {
    renderPage();
    changeField("Name", "My Factory 2");
    expect(screen.getByLabelText("Factory id")).toHaveValue("my-factory-2");
    changeField("Factory id", "custom");
    changeField("Name", "Other");
    expect(screen.getByLabelText("Factory id")).toHaveValue("custom");
  });

  it("active_switch_has_the_design_label_and_defaults_on", () => {
    renderPage();
    expect(screen.getByRole("switch", { name: "Active: the factory takes new work as soon as it's saved" })).toBeChecked();
  });

  it("starts_with_dev_stg_main_and_main_cannot_be_removed", () => {
    renderPage();
    expect(chips()).toEqual(["dev", "stg", "main"]);
    expect(screen.queryByRole("button", { name: "Remove main" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove dev" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove stg" })).toBeInTheDocument();
  });

  it("adds_with_the_add_button_or_enter_removes_with_x_and_ignores_blank", () => {
    renderPage();
    const field = screen.getByLabelText("Add a branch");
    changeField("Add a branch", "rel");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(field).toHaveValue("");
    changeField("Add a branch", "hotfix");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("");
    expect(chips()).toEqual(["dev", "stg", "rel", "hotfix", "main"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove rel" }));
    expect(chips()).toEqual(["dev", "stg", "hotfix", "main"]);
    changeField("Add a branch", "   ");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(chips()).toEqual(["dev", "stg", "hotfix", "main"]);
    expect(field).toHaveValue("");
  });

  it("summary_follows_the_form", () => {
    renderPage();
    const aside = summary();
    const value = (term: string) => within(aside).getByText(term).nextElementSibling;
    expect(value("Name (id)")).toHaveTextContent("—");
    expect(value("Protected")).toHaveTextContent("dev, stg, main");
    expect(value("Starts")).toHaveTextContent("Active");
    expect(aside).toHaveTextContent("After you create it, the Board's factory filter shows it, and new tasks can be made for it.");
    changeField("Name", "Acme");
    expect(value("Name (id)")).toHaveTextContent("Acme (acme)");
    changeField("GitHub login", "octocat");
    expect(value("Opens PRs as")).toHaveTextContent("octocat");
    changeField("Commit name", "Jane");
    changeField("Commit email", "jane@x.com");
    expect(value("Commits as")).toHaveTextContent("Jane <jane@x.com>");
    fireEvent.click(screen.getByRole("button", { name: "Remove dev" }));
    expect(value("Protected")).toHaveTextContent("stg, main");
    fireEvent.click(screen.getByRole("switch"));
    expect(value("Starts")).toHaveTextContent("Paused");
  });

  it("footer_has_create_primary_cancel_and_names_the_factory", () => {
    renderPage();
    expect(within(form()).getByRole("button", { name: "Create factory" })).toHaveClass("sf-button-primary");
    expect(within(form()).getByRole("button", { name: "Cancel" })).not.toHaveClass("sf-button-primary");
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === footerText("The factory"))).toBeInTheDocument();
    changeField("Name", "Echo");
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === footerText("Echo"))).toBeInTheDocument();
  });

  it("creates_the_factory_with_main_protected_refreshes_and_goes_to_settings", async () => {
    const { client, onNavigate } = renderPage();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    changeField("Name", "Echo");
    fireEvent.click(screen.getByRole("button", { name: "Remove dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove stg" }));
    changeField("Add a branch", "rel");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(within(form()).getByRole("button", { name: "Create factory" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/settings"));
    const saved = (await owner().listFactoryDefs()).find((d) => d.factoryId === "echo")!;
    // The GitHub login was left empty: the core default is what is saved.
    expect(saved).toMatchObject({ active: true, ghUser: "kazi-lakit", name: "Echo", protectedBranches: ["rel", "main"], version: 1 });
    expect("agentModels" in saved).toBe(false);
    expect((await owner().listEvents("-")).map((e) => e.field)).toContain("def.protectedBranches");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: FACTORIES_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: HISTORY_KEY });
  });

  it("saves_the_github_login_given", async () => {
    const { onNavigate } = renderPage();
    changeField("Name", "Echo");
    changeField("GitHub login", " octocat ");
    fireEvent.click(within(form()).getByRole("button", { name: "Create factory" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/settings"));
    expect((await owner().listFactoryDefs()).find((d) => d.factoryId === "echo")).toMatchObject({ ghUser: "octocat" });
  });

  it("refuses_a_github_login_that_is_not_one_and_saves_nothing", async () => {
    const save = vi.spyOn(owner(), "saveFactoryDef");
    renderPage();
    changeField("Name", "Echo");
    changeField("GitHub login", "keychain:echo");
    fireEvent.click(within(form()).getByRole("button", { name: "Create factory" }));
    expect(await within(form()).findByRole("alert")).toHaveTextContent("ghUser must be a GitHub login");
    expect(save).not.toHaveBeenCalled();
  });

  it("shows_the_validation_message_for_an_invalid_id_and_saves_nothing", async () => {
    const save = vi.spyOn(owner(), "saveFactoryDef");
    renderPage();
    changeField("Name", "Bad");
    changeField("Factory id", "Bad_ID");
    fireEvent.click(within(form()).getByRole("button", { name: "Create factory" }));
    expect(await within(form()).findByRole("alert")).toHaveTextContent("factoryId must match");
    expect(save).not.toHaveBeenCalled();
  });

  it("says_an_existing_id_already_exists_and_keeps_the_draft", async () => {
    const { onNavigate } = renderPage();
    changeField("Name", "Again");
    changeField("Factory id", "delta");
    fireEvent.click(within(form()).getByRole("button", { name: "Create factory" }));
    expect(await within(form()).findByRole("alert")).toHaveTextContent("Factory delta already exists. Pick another id.");
    expect(within(form()).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Again");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("cancel_goes_back_to_settings", () => {
    const { onNavigate } = renderPage();
    fireEvent.click(within(form()).getByRole("button", { name: "Cancel" }));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });

  it("labels_and_inputs_follow_the_design", () => {
    renderPage();
    const labels = Array.from(form().querySelectorAll("label.sf-field-label"));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const control = form().querySelector(`#${CSS.escape(label.getAttribute("for") ?? "")}`);
      expect(control, label.textContent ?? "").not.toBeNull();
      if (control?.tagName === "INPUT" || control?.tagName === "TEXTAREA") expect(control, label.textContent ?? "").toHaveClass("sf-input");
    }
    expect(screen.getByLabelText("Factory id")).toHaveClass("sf-mono");
  });

  it("adds_no_repo_picker_or_gh_check_again", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /check again/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/repo/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("New factory import tab", () => {
  const openImportTab = () => {
    const page = renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "Import from a file" }));
    return page;
  };

  beforeEach(() => {
    resetFakeBoard({ defs: [], repos: [] });
  });

  it("import_tab_shows_the_text_and_controls", () => {
    openImportTab();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText((_, el) => el?.tagName === "P" && el.textContent === "Use the file written by factory migrate --export. It holds no secrets.")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Import file")).toHaveAttribute("type", "file");
    expect(within(panel).getByLabelText("Or paste the JSON")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Review import" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: "Import factory" })).not.toBeInTheDocument();
  });

  it("import_tab_runs_review_confirm_and_done_returns_to_settings", async () => {
    const { onNavigate } = openImportTab();
    changeField("Or paste the JSON", importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("region", { name: "Import result" })).toHaveTextContent("Factory: created.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });

  it("import_tab_reads_a_picked_file", async () => {
    openImportTab();
    const json = importJson();
    fireEvent.change(screen.getByLabelText("Import file"), { target: { files: [new File([json], "f.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByLabelText("Or paste the JSON")).toHaveValue(json));
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(await screen.findByRole("region", { name: "Import review" })).toBeInTheDocument();
  });

  it("import_tab_cancel_returns_to_settings", () => {
    const { onNavigate } = openImportTab();
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Cancel" }));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });
});
