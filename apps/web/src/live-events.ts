import { eventStreamPath, streamFrameSchema } from "@babojubot/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryKeys } from "./api.ts";

/**
 * 셸은 전체 조직 Event stream 하나를 구독한다. Event는 관련 조회를 다시 불러오게 할 뿐이고,
 * 구독이 성립하거나 다시 연결될 때마다 전체를 재조회해 그 사이 놓친 변화를 맞춘다.
 */
export function useLiveEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      const url = new URL(eventStreamPath, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (message) => {
        let frame;
        try {
          frame = streamFrameSchema.safeParse(JSON.parse(String(message.data)));
        } catch {
          return;
        }
        if (!frame.success) return;
        if (frame.data.type === "ready") {
          attempt = 0;
          void queryClient.invalidateQueries();
          return;
        }
        const { event } = frame.data;
        void queryClient.invalidateQueries({ queryKey: queryKeys.organizations, exact: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.organization(event.organizationId) });
      };
      socket.onclose = () => {
        if (stopped) return;
        retry = setTimeout(connect, Math.min(1_000 * 2 ** attempt++, 10_000));
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [queryClient]);
}
