import ReactMarkdown from "react-markdown";
import type { Concept } from "../api";

/** Renders a concept: frontmatter card + markdown body with in-app link navigation. */
export function ConceptView({
  concept,
  onNavigate,
}: {
  concept: Concept;
  onNavigate: (path: string) => void;
}) {
  const fm = concept.frontmatter;
  const extraKeys = Object.entries(fm).filter(
    ([k]) => !["type", "title", "description", "resource", "tags", "timestamp"].includes(k)
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-purple-900/60 px-2 py-0.5 text-xs font-medium text-purple-300">
            {fm.type}
          </span>
          {Array.isArray(fm.tags) &&
            (fm.tags as string[]).map((t) => (
              <span key={t} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-cyan-300">
                #{t}
              </span>
            ))}
          {typeof fm.timestamp === "string" && (
            <span className="ml-auto text-xs text-zinc-500">
              {new Date(fm.timestamp).toLocaleString()}
            </span>
          )}
        </div>
        <h1 className="mt-2 text-2xl font-bold">{String(fm.title ?? concept.path)}</h1>
        {typeof fm.description === "string" && (
          <p className="mt-1 text-sm text-zinc-400">{fm.description}</p>
        )}
        {typeof fm.resource === "string" && (
          <p className="mt-1 truncate font-mono text-xs text-zinc-500">{fm.resource}</p>
        )}
        {extraKeys.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            {extraKeys.map(([k, v]) => (
              <span key={k}>
                <span className="text-zinc-400">{k}:</span> {JSON.stringify(v)}
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 font-mono text-xs text-zinc-600">{concept.path}</p>
      </div>

      <div className="markdown">
        <ReactMarkdown
          components={{
            a: ({ href, children }) => {
              // Bundle-relative concept links navigate in-app.
              if (href?.startsWith("/") && href.endsWith(".md")) {
                return (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(href);
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {concept.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
