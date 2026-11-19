import {
  eventStreamPath,
  orIfUnreadable,
  streamFrameSchema,
} from "@babojubot/contracts";
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
    // 관찰점: 진행 중인 조회에 신호가 와서 끝난 뒤 다시 불러올 조회 목록. E2E가 "늦은 응답을 붙잡은 동안 후속 Event를
    // 처리했다"를 확인하는 데 쓴다. 보이지 않는 data 속성이라 화면·화면 읽기에 영향이 없고, 목록이 바뀔 때만 쓴다.
    const root = document.documentElement;
    const live = createLiveRefresh(queryClient, {
      onQueued: (queryHashes) => {
        if (queryHashes.length > 0)
          root.dataset.liveRefreshQueued = JSON.stringify(queryHashes);
        else delete root.dataset.liveRefreshQueued;
      },
    });
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      const url = new URL(eventStreamPath, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (message) => {
        const frame = orIfUnreadable(
          () => streamFrameSchema.safeParse(JSON.parse(String(message.data))),
          undefined
        );
        if (!frame?.success) return;
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
