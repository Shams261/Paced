import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthApp } from "./AuthApp.js";
import { App } from "./App.js";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {import.meta.env.VITE_HOSTED_AUTH === "1" ? <AuthApp /> : <App />}
  </StrictMode>,
);
