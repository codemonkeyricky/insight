import { useEffect, useState } from "react";
import { api } from "./api";
import { parseRoute, type Route } from "./router";
import { ProjectsPage } from "./pages/Projects";
import { ProjectOverviewPage } from "./pages/ProjectOverview";
import { LensPage } from "./pages/LensPage";

function useRoute(): Route {
  const read = () => parseRoute(window.location.hash);
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [server, setServer] = useState<string>("checking");
  useEffect(() => {
    api
      .health()
      .then((h) => setServer(`server ${h.version}`))
      .catch(() => setServer("server unreachable"));
  }, []);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">
          Insight
        </a>
        <span className="muted small">{server}</span>
      </header>
      <main>
        {route.name === "projects" && <ProjectsPage />}
        {route.name === "project" && <ProjectOverviewPage key={route.id} id={route.id} />}
        {route.name === "lens" && <LensPage key={`${route.id}/${route.lensId}`} id={route.id} lensId={route.lensId} />}
        {route.name === "unknown" && <p>Page not found. <a href="#/">Back to projects</a></p>}
      </main>
    </div>
  );
}
