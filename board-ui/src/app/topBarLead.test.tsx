import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBarLeadContext, useTopBarLead, type Lead } from "./topBarLead";

afterEach(cleanup);

function Probe({ label = "Back", onClick = () => undefined }: { label?: string; onClick?: () => void }) {
  useTopBarLead({ label, onClick });
  return <p>probe</p>;
}

describe("useTopBarLead", () => {
  it("does nothing without a provider", () => {
    render(<Probe />);
    expect(screen.getByText("probe")).toBeInTheDocument();
    expect(document.querySelector(".sf-topbar-lead")).toBeNull();
  });

  it("registers a lead on mount and clears it on unmount", () => {
    const set = vi.fn();
    const view = render(
      <TopBarLeadContext.Provider value={set}>
        <Probe />
      </TopBarLeadContext.Provider>
    );
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Back" }));
    view.unmount();
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it("keeps the latest onClick without re-registering", () => {
    const leads: Array<Lead | null> = [];
    const first = vi.fn();
    const second = vi.fn();
    const setter = (lead: Lead | null) => void leads.push(lead);
    function Host() {
      const [n, setN] = useState(0);
      return (
        <TopBarLeadContext.Provider value={setter}>
          <Probe onClick={n === 0 ? first : second} />
          <button type="button" onClick={() => setN(1)}>rerender</button>
        </TopBarLeadContext.Provider>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("rerender"));
    expect(leads).toHaveLength(1);
    leads[0]?.onClick();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
