import {
  organizationDetailSchema,
  organizationListSchema,
  type CreateOrganizationInput,
  type Organization,
  type OrganizationDetail,
} from "@babojubot/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";

export const queryKeys = {
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`API ${status}`);
    this.status = status;
  }
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit
): Promise<z.infer<T>> {
  const res = await fetch(path, init);
  if (!res.ok) throw new ApiError(res.status);
  return schema.parse(await res.json());
}

export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.organizations,
    queryFn: () => request(organizationListSchema, "/api/organizations"),
  });
}

export function useOrganization(id: string) {
  return useQuery({
    queryKey: queryKeys.organization(id),
    queryFn: () =>
      request(
        organizationDetailSchema,
        `/api/organizations/${encodeURIComponent(id)}`
      ),
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 3,
  });
}

/** 성공 응답으로 캐시를 바로 채운다. 같은 생성의 Event가 먼저 와도 목록에 두 번 들어가지 않는다. */
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      request(organizationDetailSchema, "/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (org: OrganizationDetail) => {
      queryClient.setQueryData(queryKeys.organization(org.id), org);
      const { agents: _agents, ...summary } = org;
      queryClient.setQueryData<Organization[]>(
        queryKeys.organizations,
        (list) =>
          list && !list.some((o) => o.id === org.id) ? [...list, summary] : list
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organizations,
        exact: true,
      });
    },
  });
}
