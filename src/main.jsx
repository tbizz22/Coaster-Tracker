import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../credit-tracker.jsx";
import AuthGate from "./AuthGate.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
);
