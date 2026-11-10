import { useId } from "react";
import type { FactoryDef } from "@factory/core";

/** The factory filter: every factory, or one. Sits next to the repo filter. */
export function FactoryPicker({ defs, onChange, value }: { defs: readonly FactoryDef[]; onChange: (value: string) => void; value: string }) {
  const id = useId();
  return (
    <label className="sf-inline-field" htmlFor={id}>
      <span>Factory</span>
      <select id={id} className="sf-select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="all">All factories</option>
        {defs.map((def) => <option key={def.factoryId} value={def.factoryId}>{def.name}</option>)}
      </select>
    </label>
  );
}
