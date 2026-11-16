import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { CompetitorsPage } from "./pages/CompetitorsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { TimelinePage } from "./pages/TimelinePage";

/** The two views, inside the shared layout. Exported so tests can render the same routes. */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <CompetitorsPage /> },
      { path: "competitors/:id", element: <TimelinePage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
