import { meshThickness } from "./verify/mesh.js";

declare function render(node: unknown): void;

export function App() {
  return <div>{meshThickness(2)}</div>;
}

render(<App />);
