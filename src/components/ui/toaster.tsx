"use client";

import { Toaster } from "react-hot-toast";

export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      reverseOrder={false}
      gutter={8}
      toastOptions={{
        duration: 3800,
        style: {
          background: "#7B1113",
          color: "#FFFFFF",
          fontSize: "13px",
          fontWeight: 600,
          borderRadius: "12px",
          padding: "10px 16px",
          boxShadow: "0 10px 30px rgba(36, 16, 18, 0.25)",
          maxWidth: "520px",
        },
        success: {
          iconTheme: { primary: "#FFFFFF", secondary: "#7B1113" },
        },
        error: {
          style: { background: "#7F1D1D" },
          iconTheme: { primary: "#FFFFFF", secondary: "#7F1D1D" },
        },
      }}
    />
  );
}
