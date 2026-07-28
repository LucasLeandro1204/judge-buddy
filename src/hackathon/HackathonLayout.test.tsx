import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HackathonLayout } from "./HackathonLayout";

vi.mock("@/auth/useAuth", () => ({
  useAuth: () => ({
    authStatus: "idle",
    authenticated: false,
    openAuthDialog: vi.fn(),
    signOut: vi.fn(),
    user: null,
  }),
}));

vi.mock("@/hackathon/api", () => ({
  fetchHealth: vi.fn(() => new Promise(() => undefined)),
}));

const CREATOR_LINKEDIN = "https://www.linkedin.com/in/lucasleandro1204/";

describe("shared creator credit", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("links every app route to Lucas's LinkedIn profile", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter
            initialEntries={["/hackathon/agents"]}
            future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
          >
            <HackathonLayout>
              <div>Operations</div>
            </HackathonLayout>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const credit = container.querySelector(`a[href="${CREATOR_LINKEDIN}"]`);

    expect(credit).toHaveTextContent("Built by Lucas Leandro Ramos");
    expect(credit).toHaveAttribute("target", "_blank");
    expect(credit?.getAttribute("rel")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["author", "me", "noopener", "noreferrer"]),
    );
  });
});
