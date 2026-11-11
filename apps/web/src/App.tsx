import { useEffect, useState } from "react";
import { api, IS_DEMO, IS_HOSTED } from "./api";
import type { DemoMeta } from "./staticApi";
import { staticApi } from "./staticApi";
import { parseRoute, type Route } from "./router";
import { ProjectsPage } from "./pages/Projects";
import { HostedHome } from "./pages/HostedHome";
import { HostedIndexPage } from "./pages/HostedIndex";
import { Workspace } from "./components/Workspace";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { AuthChip } from "./components/HostedAuth";
import { BrandMark } from "./components/sheet/BrandMark";

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
    <div className={route.name === "workspace" ? "app wide" : route.name === "projects" || route.name === "hosted" ? "app home" : "app"}>
      {route.name !== "workspace" && (
        <header className="sh-top sh-page-top">
          <BrandMark />
          <div className="sh-spacer" />
          <div className="sh-tools">
            <span className="sh-server">{IS_HOSTED ? "read-only, hosted" : IS_DEMO ? "read-only demo" : server}</span>
            {IS_HOSTED && <AuthChip />}
            {IS_DEMO && meta && (
              <span className="sh-server mono" title={`captured ${meta.capturedAt}`}>
                Insight at {meta.commit}
              </span>
            )}
            <ThemeSwitch />
          </div>
        </header>
      )}
      <main>
        {route.name === "projects" && (IS_HOSTED ? <HostedHome /> : <ProjectsPage />)}
        {route.name === "hosted" &&
          (IS_HOSTED ? (
            <HostedIndexPage key={`${route.owner}/${route.repo}@${route.sha ?? ""}`} owner={route.owner} repo={route.repo} sha={route.sha} />
          ) : (
            <p>
              Page not found. <a href="#/">Back to projects</a>
            </p>
          ))}
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
            full={route.full}
            findingKind={route.kind}
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
