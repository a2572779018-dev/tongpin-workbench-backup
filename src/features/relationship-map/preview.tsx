import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import { RelationshipMapPage } from "../../pages/RelationshipMapPage";
import "../../styles.css";

document.documentElement.dataset.appView = "relations";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RelationshipMapPage userId="preview-member" previewMode />
  </StrictMode>,
);
