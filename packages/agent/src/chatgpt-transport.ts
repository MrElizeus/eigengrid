import { ChatGptAuth, ChatGptAuthError, CHATGPT_RESOURCE } from "./chatgpt-auth";

/** Pin OAuth credentials to the official Responses endpoint and require completed SSE. */
export function chatGptFetch(
  auth: ChatGptAuth,
  profileId: string,
  upstream: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${CHATGPT_RESOURCE}/responses` || init?.method !== "POST")
      throw new Error(
        "ChatGPT plan credentials may only be used with the official Responses endpoint",
      );
    if (typeof init.body !== "string") throw new Error("Invalid ChatGPT inference request");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.stream !== true) throw new Error("ChatGPT plan inference requires streaming");
    body.store = false;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await auth.accessToken(profileId)}`);
    const response = await upstream(url, {
      ...init,
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) return response;
    let completed = false;
    let pending = "";
    const decoder = new TextDecoder();
    const guard = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 1_000_000)
          throw new Error("ChatGPT stream event exceeded the permitted size");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const value = line.slice(5).trim();
          if (!value || value === "[DONE]") continue;
          const event = JSON.parse(value) as {
            type?: string;
            response?: { error?: { code?: string } };
          };
          if (event.type === "response.completed") completed = true;
          if (["response.failed", "response.incomplete", "error"].includes(event.type ?? ""))
            throw new ChatGptAuthError(
              event.response?.error?.code ?? "incomplete_response",
              response.status,
              response.headers.get("x-request-id") ?? undefined,
            );
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (!completed) throw new Error("ChatGPT stream ended without a completed response");
      },
    });
    return new Response(response.body.pipeThrough(guard), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as unknown as typeof fetch;
}
