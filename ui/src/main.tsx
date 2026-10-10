import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";
import "highlight.js/styles/github-dark.css";

// No browser context menu or reload shortcuts inside the app.
window.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("keydown", (e) => {
  if ((e.key === "F5" && !e.ctrlKey) || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
}, { capture: true });

render(() => <App />, document.getElementById("root")!);
