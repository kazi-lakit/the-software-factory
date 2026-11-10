/** A timestamp in the viewer's locale; an unparseable value is shown as given. */
export const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};
