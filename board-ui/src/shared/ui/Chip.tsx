export function ChipList({ empty, items }: { empty: string; items?: string[] }) {
  if (!items || items.length === 0) return <p className="sf-empty">{empty}</p>;

  return (
    <ul className="sf-chips">
      {items.map((item) => <li key={item} className="sf-chip">{item}</li>)}
    </ul>
  );
}
