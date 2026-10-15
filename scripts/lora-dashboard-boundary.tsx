import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LoraDashboardErrorBoundary } from "../src/components/LoraDashboardErrorBoundary";

let broken = true;
function Dashboard() {
  if (broken) throw new TypeError("synthetic chart failure");
  return <p>驾驶舱已恢复</p>;
}
function Fixture() {
  const [, rerender] = useState(0);
  return <><nav>外壳导航仍可用</nav><button onClick={() => { broken = false; rerender(1); }}>修复夹具</button><LoraDashboardErrorBoundary><Dashboard /></LoraDashboardErrorBoundary></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
