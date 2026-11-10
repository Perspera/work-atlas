import { useQuery } from "@tanstack/react-query";

import { api } from "./api";
import { clock } from "./format";
import { queryClient } from "./query";
import { useApp } from "./store";
import type { Me, Meta } from "./types";

export const ME_KEY = ["me"] as const;
export const META_KEY = ["meta"] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<Me>("/api/me"),
    staleTime: 60_000,
  });
}

export function useMeta() {
  return useQuery({
    queryKey: META_KEY,
    queryFn: () => api<Meta>("/api/meta"),
    staleTime: 30_000,
  });
}

/** 业务日期：顶栏切换后所有页面共用。 */
export function useBizDate() {
  return useApp((state) => state.date);
}

/**
 * SSE 实时刷新：收到 update 事件后统一失效所有查询，
 * 由 TanStack Query 决定哪些真正重取，避免每个页面各自轮询。
 */
export function startEventStream(): () => void {
  let source: EventSource | null = null;
  let timer = 0;
  let reconnect = 0;
  let closed = false;
  const { setOnline, touch } = useApp.getState();

  const connect = () => {
    if (closed) return;
    source = new EventSource("/api/events");
    source.addEventListener("ready", () => {
      setOnline(true);
    });
    source.addEventListener("update", () => {
      setOnline(true);
      touch(clock());
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        queryClient.invalidateQueries();
      }, 800);
    });
    source.onerror = () => {
      setOnline(false);
      source?.close();
      source = null;
      if (closed) return;
      reconnect = window.setTimeout(connect, 5000);
    };
  };

  connect();

  return () => {
    closed = true;
    window.clearTimeout(timer);
    window.clearTimeout(reconnect);
    source?.close();
  };
}
