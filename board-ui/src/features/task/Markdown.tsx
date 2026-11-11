import ReactMarkdown from "react-markdown";

/**
 * A doc body as Markdown in the reading style. HTML in the body is never rendered: do not add rehype-raw.
 * The default URL transform drops unsafe links such as javascript: URLs.
 */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown>{body}</ReactMarkdown>
    </div>
  );
}
