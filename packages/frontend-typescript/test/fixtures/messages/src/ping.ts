// The addEventListener form on the worker side: a bare name, and self on the same listener.
addEventListener("message", (e) => {
  self.postMessage({ echo: e.data });
});
