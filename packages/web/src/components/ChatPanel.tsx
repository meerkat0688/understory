import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import { authHeaders } from "../api";
import type { AppConfig } from "../api";
import {
  DEFAULT_CHAT_LIMITS,
  prepareChatMessages,
  utf8Bytes,
} from "../chat-history";

const WRITE_TOOLS = new Set(["write_concept", "patch_concept", "delete_concept"]);

type ChatMessageMetadata = {
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
  };
  estimatedCostUsd?: number | null;
  costSource?: "provider" | "estimate" | null;
};

type ChatMessage = UIMessage<ChatMessageMetadata>;

/** Pending /add: stop active request, wait until idle, then clear and send. */
type PendingAdd = { knowledge: string };

function parseAddCommand(input: string): PendingAdd | null {
  const trimmed = input.trim();
  const addMatch = trimmed.match(/^\/add(?:\s+([\s\S]*))?$/i);
  if (!addMatch) return null;
  return { knowledge: (addMatch[1] ?? "").trim() };
}

/**
 * Chat with the same agent the MCP server runs. Tool calls render inline —
 * watching which tools fire on which files is how we test the agent.
 */
export function ChatPanel({
  config,
  onMutation,
  onOpenConcept,
}: {
  config: AppConfig | null;
  onMutation: () => void;
  onOpenConcept: (path: string) => void;
}) {
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const pendingAddRef = useRef<PendingAdd | null>(null);
  const addEpochRef = useRef(0);
  const completedAddEpochRef = useRef(0);
  const lastSubmittedInput = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const limits = config?.chat ?? DEFAULT_CHAT_LIMITS;
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => authHeaders(),
        body: () => ({ provider }),
        prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => {
          const prepared = prepareChatMessages(messages, limits);
          const requestBody = {
            ...body,
            id,
            messages: prepared.messages,
            trigger,
            messageId,
          };
          if (utf8Bytes(requestBody) > limits.maxRequestBytes) {
            throw new Error(
              "The newest message exceeds the configured chat request-size limit."
            );
          }
          setHistoryNotice(
            prepared.removedMessages > 0
              ? prepared.importMode
                ? `Large knowledge import: omitted ${prepared.removedMessages} earlier messages.`
                : `Omitted ${prepared.removedMessages} earlier messages to protect context space.`
              : null
          );
          return { body: requestBody };
        },
      }),
    [limits, provider]
  );
  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    clearError,
  } = useChat<ChatMessage>({
    transport,
    onFinish: ({ isAbort }) => {
      // During /add reset, keep lastSubmittedInput for the upcoming send / error restore.
      if (!isAbort && !pendingAddRef.current) {
        lastSubmittedInput.current = "";
      }
      onMutation(); // refresh browse pane; agent may have written files
    },
  });

  const busy = status === "submitted" || status === "streaming";
  const resetting = pendingAdd !== null;

  function queueAdd(knowledge: string) {
    addEpochRef.current += 1;
    const next = { knowledge };
    pendingAddRef.current = next;
    setPendingAdd(next);
    setInput("");
    clearError();
    if (busy) stop();
  }

  // After stop() settles (status leaves submitted/streaming), clear then send.
  useEffect(() => {
    if (!pendingAdd || busy) return;
    const epoch = addEpochRef.current;
    if (completedAddEpochRef.current === epoch) return;
    completedAddEpochRef.current = epoch;

    const knowledge = pendingAdd.knowledge;
    pendingAddRef.current = null;
    setPendingAdd(null);

    setMessages([]);
    setHistoryNotice(null);
    clearError();
    setInput("");

    if (!knowledge) {
      lastSubmittedInput.current = "";
      return;
    }

    lastSubmittedInput.current = knowledge;
    void sendMessage({ text: knowledge });
  }, [pendingAdd, busy, setMessages, clearError, sendMessage]);

  useEffect(() => {
    if (error && !input && lastSubmittedInput.current) {
      setInput(lastSubmittedInput.current);
    }
  }, [error, input]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [input]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-300">Agent chat</span>
        {config && (
          <select
            value={provider ?? config.defaultProvider}
            onChange={(e) => setProvider(e.target.value)}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300"
          >
            {config.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Test the knowledge agent here — ask a question, or tell it something worth
            remembering. Tool calls show inline so you can watch it work.{" "}
            <span className="font-mono text-zinc-400">/add …</span> clears the session,
            then ingests the knowledge that follows.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
            {m.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div
                    key={i}
                    className={`markdown inline-block max-w-[95%] rounded-xl px-3 py-2 text-left text-sm ${
                      m.role === "user" ? "bg-cyan-900/50" : "bg-zinc-900 border border-zinc-800"
                    }`}
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                );
              }
              if (part.type.startsWith("tool-")) {
                const toolName = part.type.slice(5);
                const p = part as unknown as {
                  state: string;
                  input?: Record<string, unknown>;
                  output?: unknown;
                };
                const filePath =
                  typeof p.input?.path === "string" ? (p.input.path as string) : undefined;
                return (
                  <div
                    key={i}
                    className={`my-1 flex items-center gap-2 rounded-lg border px-2 py-1 font-mono text-xs ${
                      WRITE_TOOLS.has(toolName)
                        ? "border-amber-800/60 bg-amber-950/30 text-amber-300"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400"
                    }`}
                  >
                    <span>{p.state === "output-available" ? "✓" : "…"}</span>
                    <span className="font-semibold">{toolName}</span>
                    {filePath && (
                      <button
                        onClick={() => onOpenConcept(filePath)}
                        className="truncate text-cyan-400 hover:underline"
                      >
                        {filePath}
                      </button>
                    )}
                    {!filePath && typeof p.input?.query === "string" && (
                      <span className="truncate text-zinc-500">"{String(p.input.query)}"</span>
                    )}
                  </div>
                );
              }
              return null;
            })}
            {m.role === "assistant" && <UsageFooter metadata={m.metadata} />}
          </div>
        ))}
        {(busy || resetting) && (
          <div className="animate-pulse text-xs text-zinc-500">
            {resetting && !busy ? "starting clean session…" : "agent working…"}
          </div>
        )}
        {historyNotice && <p className="text-xs text-amber-400">{historyNotice}</p>}
        {error && (
          <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-2 text-xs text-red-300">
            <p>{formatChatError(error)}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  clearError();
                  void regenerate();
                }}
                className="rounded border border-red-800 px-2 py-1 hover:bg-red-950"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={clearError}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const submitted = input.trim();
          if (!submitted || resetting) return;
          const add = parseAddCommand(submitted);
          if (add) {
            queueAdd(add.knowledge);
            return;
          }
          if (busy) return;
          lastSubmittedInput.current = submitted;
          clearError();
          void sendMessage({ text: submitted });
          setInput("");
        }}
        className="border-t border-zinc-800/80 bg-zinc-950/50 p-3"
      >
        <div
          className={`rounded-xl border bg-zinc-900/60 shadow-sm transition-[border-color,box-shadow] ${
            busy || resetting
              ? "border-zinc-800"
              : "border-zinc-800/90 focus-within:border-zinc-600 focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.08)]"
          }`}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (error) clearError();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask, or /add your knowledge…"
            rows={1}
            className="block w-full resize-none bg-transparent px-3.5 py-3 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800/60 px-2 py-1.5">
            <span className="px-1.5 text-[10px] text-zinc-600">
              Enter to send · /add knowledge (clears session first)
            </span>
            <button
              type="submit"
              disabled={
                !input.trim() ||
                resetting ||
                (busy && parseAddCommand(input.trim()) === null)
              }
              aria-label="Send message"
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {busy || resetting ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-cyan-200/30 border-t-cyan-100" />
                  Sending
                </>
              ) : (
                "Send"
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function formatChatError(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as {
      error?: { code?: string; message?: string };
    };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Streaming and client-side errors are already plain text.
  }
  return error.message || "The chat request failed.";
}

function formatTokenCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function UsageFooter({ metadata }: { metadata?: ChatMessageMetadata }) {
  const usage = metadata?.usage;
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input <= 0 && output <= 0) return null;

  const cost =
    typeof metadata?.estimatedCostUsd === "number" ? metadata.estimatedCostUsd : null;
  const parts = [
    `${formatTokenCount(input)} in`,
    `${formatTokenCount(output)} out`,
  ];
  if (cost != null) {
    const label = metadata?.costSource === "provider" ? "Cost" : "Est.";
    parts.unshift(`${label} ${formatUsd(cost)}`);
  }

  return <p className="mt-1 text-[10px] text-zinc-500">{parts.join(" · ")}</p>;
}
