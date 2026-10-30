import { eventStreamPath, streamFrameSchema } from "@babojubot/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryKeys } from "./api.ts";
import { createLiveRefresh } from "./live-refresh.ts";

/**
 * 셸은 전체 조직 Event stream 하나를 구독한다. Event와 전역 설정 변경 신호는 관련 조회를 다시 불러오게 할 뿐이고,
 * 구독이 성립하거나 다시 연결될 때마다 전체를 재조회해 그 사이 놓친 변화를 맞춘다.
 * 재조회 조율은 `createLiveRefresh`가 맡는다.
 */
export function useLiveEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const live = createLiveRefresh(queryClient);
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
          live.refresh();
          return;
        }
        if (frame.data.type === "settings_changed") {
          live.refresh({ queryKey: queryKeys.providers, exact: true });
          return;
        }
        const { event } = frame.data;
        live.refresh({ queryKey: queryKeys.organizations, exact: true });
        live.refresh({
          queryKey: queryKeys.organization(event.organizationId),
        });
        live.refresh({ queryKey: queryKeys.inbox });
        live.refresh({ queryKey: queryKeys.overview });
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
      live.dispose();
    };
  }, [queryClient]);
}
