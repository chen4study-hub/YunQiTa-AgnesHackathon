import { createRoot } from "react-dom/client";
import { installDeviceDataCache } from "./data/deviceDataCache";
import { App } from "./App";
import { DashboardStore } from "./state/store";
import { createSource } from "./data/source";
import { opsClock } from "./data/ops/runtime";
import "./ui/styles.css";
import "./ui/responsive.css";

installDeviceDataCache();
const host = document.getElementById("app");
if (!host) throw new Error("Missing application host");
const store = new DashboardStore(createSource(location.search), undefined, {now: opsClock.now});
void opsClock.sync().then(() => store.syncClock());
createRoot(host).render(<App store={store} />);
