import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Chat, type State } from "./client";
import type { ChatMessage } from "./store";
import { commands, filterCommands, resolveTheme, type Command, type Theme } from "./commands";
export function useWorkspace() {
  const [state, setState] = useState<State>();
  const [chat, setChat] = useState<Chat>();
  const [draft, setDraft] = useState(() => sessionStorage.getItem("eigengrid-draft:new") ?? "");
  const [busy, setBusy] = useState(false);
  const [steering, setSteering] = useState("");
  const [sendingSteer, setSendingSteer] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modal, setModal] = useState<"help" | "rename" | "delete" | null>(null);
  const [rename, setRename] = useState("");
  const [invitation, setInvitation] = useState<{ url: string; expires: string }>();
  const [sidebar, setSidebar] = useState(() => matchMedia("(min-width: 900px)").matches);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("eigengrid-theme");
    return saved === "dark" || saved === "light" ? saved : "system";
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [editing, setEditing] = useState<number>();
  const [follow, setFollow] = useState(true);
  const [online, setOnline] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const initialized = useRef(false);
  const chatRef = useRef<Chat>();
  const editDraft = useRef("");
  const turnStarted = useRef(Date.now());
  const effectiveBusy = busy || !!(chat && state?.activeId === chat.id);
  const messages = chat?.messages ?? [];
  const palette = !menuDismissed && (menuOpen || (draft.startsWith("/") && !draft.includes("\n")));
  const query = draft.startsWith("/") ? draft.split(" ")[0]!.slice(1) : "";
  const choices = filterCommands(query);
  const visibleChats =
    state?.chats.filter((c) => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ??
    [];
  function showChat(value: Chat | undefined) {
    chatRef.current = value;
    setChat(value);
    if (value) sessionStorage.setItem("eigengrid-last-chat", value.id);
    else sessionStorage.removeItem("eigengrid-last-chat");
  }
  function notify(value: string) {
    setToast(value);
  }
  async function refresh() {
    const value = (await (await api("/state")).json()) as State;
    setState(value);
    setOnline(true);
    return value;
  }
  async function select(id: string) {
    if (lock.current) return;
    try {
      const value = await (await api(`/chats/${id}`)).json();
      showChat(value);
      setDraft(sessionStorage.getItem(`eigengrid-draft:${id}`) ?? "");
      setEditing(undefined);
      setError("");
      setFollow(true);
      if (matchMedia("(max-width: 899px)").matches) setSidebar(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function newChat() {
    if (effectiveBusy) {
      notify("Stop the response before opening a new conversation.");
      return;
    }
    showChat(undefined);
    setDraft("");
    sessionStorage.removeItem("eigengrid-draft:new");
    setEditing(undefined);
    setError("");
    setMenuOpen(false);
    setFollow(true);
    textarea.current?.focus();
  }
  async function stop() {
    if (!chatRef.current) return;
    try {
      await api(`/chats/${chatRef.current.id}/cancel`, "POST", {});
      setSteering("");
      notify("Requested to stop the response.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function exportChat() {
    if (!chat) {
      notify("Open a conversation to export it.");
      return;
    }
    const text =
      `# ${chat.title}\n\n` +
      chat.messages
        .map(
          (m) =>
            `## ${m.role === "user" ? "You" : "EigenGrid"}\n\n${m.content}${m.status === "redirected" ? "_Response redirected._" : ""}`,
        )
        .join("\n\n---\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${chat.title.replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 60) || "eigengrid"}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Conversation exported as Markdown.");
  }
  function choose(command: Command) {
    if (draft.startsWith("/")) setDraft("");
    setMenuOpen(false);
    if (command.action === "prompt") {
      setDraft(command.prompt);
      textarea.current?.focus();
      return;
    }
    if (command.action === "new") newChat();
    if (command.action === "connection") setSettingsOpen(true);
    if (command.action === "help") setModal("help");
    if (command.action === "theme") setTheme((t) => (t === "dark" ? "light" : "dark"));
    if (command.action === "export") exportChat();
    if (command.action === "stop") void stop();
    if (command.action === "rename") {
      if (chat && !effectiveBusy) {
        setRename(chat.title);
        setModal("rename");
      } else notify("Open a conversation with no active response to rename it.");
    }
  }
  useEffect(() => {
    const layout = matchMedia("(min-width: 900px)");
    const changed = () => setSidebar(layout.matches);
    layout.addEventListener("change", changed);
    return () => layout.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const sync = () => {
      void refresh()
        .then((value) => {
          if (!initialized.current) {
            initialized.current = true;
            const id = sessionStorage.getItem("eigengrid-last-chat");
            if (id && value.chats.some((c) => c.id === id)) void select(id);
          }
        })
        .catch((e) => {
          setOnline(false);
          setError(e.message);
        });
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);
  useEffect(() => {
    if (!state?.activeId || busy) return;
    const timer = setInterval(() => {
      void refresh()
        .then(async () => {
          const id = chatRef.current?.id;
          if (id) {
            const value = await (await api(`/chats/${id}`)).json();
            showChat(value);
            setSteering(value.pendingPrompt ?? "");
          }
        })
        .catch(() => setOnline(false));
    }, 1200);
    return () => clearInterval(timer);
  }, [state?.activeId, busy]);
  useEffect(() => {
    sessionStorage.setItem(`eigengrid-draft:${chat?.id ?? "new"}`, draft);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
    }
  }, [draft, chat?.id]);
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme, system.matches);
    };
    localStorage.setItem("eigengrid-theme", theme);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [chat?.messages, follow, steering]);
  useEffect(() => {
    setMenuIndex(0);
  }, [query]);
  useEffect(() => {
    if (!palette) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".composer")) {
        setMenuOpen(false);
        setMenuDismissed(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [palette]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - turnStarted.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "k") {
          event.preventDefault();
          setMenuDismissed(palette);
          setMenuOpen(!palette);
          textarea.current?.focus();
        }
        if (event.key.toLowerCase() === "b") {
          event.preventDefault();
          setSidebar((v) => !v);
        }
        if (event.shiftKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          newChat();
        }
        if (event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSidebar(true);
          searchInput.current?.focus();
        }
      }
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        if (palette) {
          setMenuOpen(false);
          setMenuDismissed(true);
        } else if (effectiveBusy) void stop();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  async function send(event?: FormEvent, override?: string, forkIndex?: number) {
    event?.preventDefault();
    const prompt = (override ?? draft).trim();
    if (!prompt) return;
    if (prompt.startsWith("/") && !override) {
      const cmd = commands.find((c) => `/${c.name}` === prompt.split(/\s/)[0]);
      if (cmd) choose(cmd);
      else {
        setError("Unknown command. Type / to see available commands.");
        setMenuDismissed(false);
        setMenuOpen(true);
      }
      return;
    }
    if (effectiveBusy) {
      if (sendingSteer || steering || !chatRef.current) return;
      setSendingSteer(true);
      setError("");
      try {
        await api(`/chats/${chatRef.current.id}/steer`, "POST", { prompt });
        setDraft((current) => (current.trim() === prompt ? "" : current));
        if (!busy) setSteering(prompt);
        setFollow(true);
      } catch (e) {
        setError((e as Error).message);
        void refresh().catch(() => {});
      } finally {
        setSendingSteer(false);
        textarea.current?.focus();
      }
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setElapsed(0);
    turnStarted.current = Date.now();
    setError("");
    setMenuOpen(false);
    setFollow(true);
    setDraft("");
    let current = chatRef.current;
    try {
      const branch = forkIndex ?? editing;
      if (branch !== undefined && current)
        current = (await (
          await api(`/chats/${current.id}/fork`, "POST", { messageIndex: branch })
        ).json()) as Chat;
      if (!current) current = (await (await api("/chats", "POST", {})).json()) as Chat;
      setEditing(undefined);
      sessionStorage.removeItem("eigengrid-draft:new");
      let rows: ChatMessage[] = [
        ...current.messages,
        { role: "user", content: prompt },
        { role: "assistant", content: "", tools: [] },
      ];
      let answer = rows.at(-1)!;
      showChat({ ...current, messages: [...rows] });
      const response = await api(`/chats/${current.id}/messages`, "POST", { prompt });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "",
        complete = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const item = JSON.parse(line);
          if (item.type === "heartbeat") continue;
          if (item.type === "done") {
            showChat(item.chat);
            complete = true;
            continue;
          }
          if (item.type === "steering") {
            setSteering(item.prompt);
            continue;
          }
          if (item.type === "turn") {
            current = item.chat as Chat;
            rows = [...current.messages, { role: "assistant", content: "", tools: [] }];
            answer = rows.at(-1)!;
            setSteering("");
            turnStarted.current = Date.now();
            setElapsed(0);
          }
          if (item.type === "text") answer.content += item.text;
          if (item.type === "tool-call") answer.tools!.push({ name: item.name, args: item.args });
          if (item.type === "tool-result") {
            const tool = [...answer.tools!]
              .reverse()
              .find((t) => t.name === item.name && t.ok === undefined);
            if (tool) {
              tool.result = item.result;
              tool.ok = item.ok;
            }
          }
          showChat({ ...current!, messages: [...rows] });
        }
      }
      if (!complete)
        throw new Error(
          "Connection lost. Your conversation is still saved; reopen it to check its status.",
        );
    } catch (e) {
      setError((e as Error).message);
      if (current) {
        try {
          showChat(await (await api(`/chats/${current.id}`)).json());
        } catch {
          setOnline(false);
        }
      }
      setDraft((value) => value || prompt);
    } finally {
      lock.current = false;
      setBusy(false);
      setSteering("");
      void refresh().catch(() => setOnline(false));
      textarea.current?.focus();
    }
  }
  function edit(index: number) {
    if (effectiveBusy) return;
    editDraft.current = draft;
    setEditing(index);
    setDraft(messages[index]!.content);
    textarea.current?.focus();
    setFollow(true);
  }
  async function renameChat(event: FormEvent) {
    event.preventDefault();
    if (!chat) return;
    try {
      showChat(await (await api(`/chats/${chat.id}`, "PATCH", { title: rename })).json());
      setModal(null);
      await refresh();
      notify("Name updated.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove() {
    if (!chat || effectiveBusy) return;
    try {
      await api(`/chats/${chat.id}`, "DELETE", {});
      sessionStorage.removeItem(`eigengrid-draft:${chat.id}`);
      showChat(undefined);
      setDraft("");
      setModal(null);
      await refresh();
      notify("Conversation deleted.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function retry(index: number) {
    const target = messages
      .slice(0, index)
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0)
      .at(-1);
    if (target !== undefined) void send(undefined, messages[target]!.content, target);
  }
  return {
    state,
    chat,
    draft,
    setDraft,
    busy,
    steering,
    sendingSteer,
    error,
    setError,
    toast,
    settingsOpen,
    setSettingsOpen,
    modal,
    setModal,
    rename,
    setRename,
    invitation,
    setInvitation,
    sidebar,
    setSidebar,
    search,
    setSearch,
    theme,
    setTheme,
    setMenuOpen,
    setMenuDismissed,
    menuIndex,
    setMenuIndex,
    editing,
    setEditing,
    follow,
    setFollow,
    online,
    elapsed,
    textarea,
    scroller,
    end,
    searchInput,
    editDraft,
    effectiveBusy,
    messages,
    palette,
    query,
    choices,
    visibleChats,
    notify,
    refresh,
    select,
    newChat,
    stop,
    exportChat,
    choose,
    send,
    edit,
    renameChat,
    remove,
    retry,
  };
}
