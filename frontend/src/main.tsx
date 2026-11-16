import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { routes } from "./App";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // One quick retry covers a blip. The lists refresh on a timer anyway.
    queries: { retry: 1 },
  },
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("The page has no #root element to render into.");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createBrowserRouter(routes)} />
    </QueryClientProvider>
  </StrictMode>,
);
