import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../app/providers/AuthProvider";
import { isLoginConfigured } from "../lib/blocks/config";
import { defaultDictionary } from "../lib/i18n/dictionary";
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../test/phoneWidth";
import { LandingPage } from "./Landing";

vi.mock("../app/providers/AuthProvider", () => ({ useAuth: vi.fn() }));
vi.mock("../lib/i18n/LocalizationProvider", () => ({
  useT: () => ({ t: (key: string) => (defaultDictionary as Record<string, string>)[key] ?? key })
}));
vi.mock("../lib/blocks/config", () => ({ isLoginConfigured: vi.fn(() => true) }));

const login = vi.fn();
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  login.mockReset();
  login.mockResolvedValue(undefined);
  vi.mocked(useAuth).mockReturnValue({ claims: undefined, login, logout: vi.fn(), refresh: vi.fn(), status: "signedOut" } as never);
  vi.mocked(isLoginConfigured).mockReturnValue(true);
  window.matchMedia = ((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const continueButton = () => screen.getByRole("button", { name: /Continue with Blocks|Redirecting/ });
const cellTitled = (title: string) => screen.getByRole("heading", { level: 3, name: title }).closest("li") as HTMLElement;

describe("LandingPage", () => {
  it("shows_the_top_bar", () => {
    const { container } = render(<LandingPage />);
    const bar = container.querySelector("header.sf-topbar") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getByText("the-software-factory")).toHaveClass("sf-label");
    expect(within(bar).getByRole("button", { name: /Switch to (light|dark) mode/ })).toBeInTheDocument();
    const signIn = within(bar).getByRole("button", { name: "Sign in" });
    expect(signIn).toHaveClass("sf-button");
    expect(signIn).not.toHaveClass("sf-button-primary");
  });

  it("shows_the_hero_copy", () => {
    const { container } = render(<LandingPage />);
    const hero = container.querySelector(".sf-landing-hero") as HTMLElement;
    const h1 = screen.getByRole("heading", { level: 1, name: "Write the task. Merge the PR." });
    expect(hero).toContainElement(h1);
    expect(
      screen.getByText(
        "The software factory turns a plain task into a reviewed pull request. Agents write the spec, plan, build test-first, verify and review. You approve at the gates and merge."
      )
    ).toHaveClass("sf-landing-lead");
    const primary = screen.getByRole("button", { name: "Continue with Blocks" });
    expect(primary).toHaveClass("sf-button", "sf-button-primary");
    expect(hero).toContainElement(primary);
    const how = screen.getByRole("link", { name: "How it works" });
    expect(how).toHaveAttribute("href", "#how-it-works");
    expect(how).toHaveClass("sf-button");
    expect(hero).toContainElement(how);
  });

  it("shows_how_it_works_with_six_cells", () => {
    render(<LandingPage />);
    const h2 = screen.getByRole("heading", { level: 2, name: "How it works" });
    const section = h2.closest("section") as HTMLElement;
    expect(section).toHaveAttribute("id", "how-it-works");
    expect(within(section).getByText("01")).toHaveClass("sf-label");
    const cells = section.querySelectorAll("li.sf-landing-cell");
    expect(cells).toHaveLength(6);
    const expected: [string, string][] = [
      ["Spec", "Turns your task into acceptance criteria."],
      ["Plan", "Breaks it into test-first steps."],
      ["Build", "Writes the code, tests first."],
      ["Verify", "Checks every criterion."],
      ["Review", "Reads the diff against the spec."],
      ["PR", "Opens a pull request into dev or stg."]
    ];
    expected.forEach(([title, text], i) => {
      const cell = cells[i] as HTMLElement;
      expect(within(cell).getByRole("heading", { level: 3 })).toHaveTextContent(title);
      expect(within(cell).getByText(text)).toBeInTheDocument();
    });
  });

  it("marks_only_spec_plan_and_pr_with_you_approve", () => {
    render(<LandingPage />);
    const chips = screen.getAllByText("You approve");
    expect(chips).toHaveLength(3);
    for (const chip of chips) expect(chip).toHaveClass("sf-badge");
    for (const title of ["Spec", "Plan", "PR"]) expect(within(cellTitled(title)).getByText("You approve")).toBeInTheDocument();
    for (const title of ["Build", "Verify", "Review"]) expect(within(cellTitled(title)).queryByText("You approve")).toBeNull();
  });

  it("shows_you_stay_in_charge_with_three_cards", () => {
    render(<LandingPage />);
    const h2 = screen.getByRole("heading", { level: 2, name: "You stay in charge" });
    const section = h2.closest("section") as HTMLElement;
    expect(within(section).getByText("02")).toHaveClass("sf-label");
    const cells = section.querySelectorAll("li.sf-landing-cell");
    expect(cells).toHaveLength(3);
    const expected: [string, string][] = [
      ["Gates", "Nothing is built before you approve the spec."],
      ["Questions", "An agent that can't go on asks you, with options and a recommendation."],
      ["Never main", "Work reaches dev, stg or main only through a PR you merge."]
    ];
    expected.forEach(([title, text], i) => {
      const cell = cells[i] as HTMLElement;
      expect(within(cell).getByRole("heading", { level: 3 })).toHaveTextContent(title);
      expect(within(cell).getByText(text)).toBeInTheDocument();
    });
  });

  it("shows_the_footer_line", () => {
    const { container } = render(<LandingPage />);
    const footer = container.querySelector("footer") as HTMLElement;
    expect(within(footer).getByText("the-software-factory · runs on Blocks")).toHaveClass("sf-label");
  });

  it("continue_calls_login_with_return_to", async () => {
    let finish!: () => void;
    login.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<LandingPage returnTo="/tasks/T-1" />);
    fireEvent.click(continueButton());
    expect(login).toHaveBeenCalledWith("/tasks/T-1");
    const pending = await screen.findByRole("button", { name: "Redirecting..." });
    expect(pending).toBeDisabled();
    finish();
  });

  it("sign_in_in_the_top_bar_calls_the_same_login", () => {
    render(<LandingPage returnTo="/tasks/T-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(login).toHaveBeenCalledWith("/tasks/T-1");
  });

  it("shows_a_sign_in_error_as_sf_problem_right_after_the_button", async () => {
    login.mockRejectedValue(new Error("Popup blocked"));
    const { container } = render(<LandingPage />);
    const button = continueButton();
    fireEvent.click(button);
    const problem = await screen.findByText("Popup blocked");
    expect(problem).toHaveClass("sf-problem");
    expect(continueButton().nextElementSibling).toBe(problem);
    expect(container.querySelector(".alert")).toBeNull();
  });

  it("warns_and_disables_both_buttons_when_login_is_not_configured", () => {
    vi.mocked(isLoginConfigured).mockReturnValue(false);
    const { container } = render(<LandingPage />);
    expect(screen.getByText(defaultDictionary["auth.notConfigured"], { exact: false })).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("code")).map((c) => c.textContent)).toContain(`${window.location.origin}/login/callback`);
    expect(screen.getByRole("button", { name: "Continue with Blocks" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });
});

describe("LandingPage at 360px", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("landing_fits_360", () => {
    const { container } = render(<LandingPage />);
    expect(container.querySelector("header.sf-topbar")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Continue with Blocks" }).length).toBeGreaterThan(0);
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
  });
});
