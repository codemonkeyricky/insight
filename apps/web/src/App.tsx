import { useEffect, useState } from "react";
import { api, IS_DEMO } from "./api";
import type { DemoMeta } from "./staticApi";
import { staticApi } from "./staticApi";
import { parseRoute, type Route } from "./router";
import { ProjectsPage } from "./pages/Projects";
import { Workspace } from "./components/Workspace";

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
  const [meta, setMeta] = useState<DemoMeta | null>(null);
  useEffect(() => {
    if (IS_DEMO) void staticApi.meta().then(setMeta).catch(() => setMeta(null));
  }, []);
  useEffect(() => {
    api
      .health()
      .then((h) => setServer(`server ${h.version}`))
      .catch(() => setServer("server unreachable"));
  }, []);

  return (
    <div className={route.name === "workspace" ? "app wide" : "app"}>
      <header className="top">
        <a className="brand" href="#/">
          Insight
        </a>
        <span className="muted small">{IS_DEMO ? "read-only demo" : server}</span>
        {IS_DEMO && meta && (
          <span className="muted small mono" title={`captured ${meta.capturedAt}`}>
            Insight at {meta.commit}
          </span>
        )}
      </header>
      <main>
        {route.name === "projects" && <ProjectsPage />}
        {route.name === "workspace" && (
          <Workspace
            key={route.id}
            id={route.id}
            tab={route.tab}
            scope={route.scope}
            line={route.line}
            fn={route.fn}
            roots={route.roots}
            base={route.base}
            head={route.head}
          />
        )}
        {route.name === "unknown" && (
          <p>
            Page not found. <a href="#/">Back to projects</a>
          </p>
        )}
      </main>
    </div>
  );
}
