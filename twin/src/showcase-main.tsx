import { createRoot } from "react-dom/client";
import { Showcase } from "./Showcase";
import { ScaleViewport } from "./components/ScaleViewport";
import "./ui/styles.css";

const host = document.getElementById("app");
if (!host) throw new Error("Missing application host");
createRoot(host).render(
  <ScaleViewport>
    <Showcase />
  </ScaleViewport>,
);
