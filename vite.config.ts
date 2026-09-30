// The app's build: React for the page, Cloudflare's plug-in for the Worker (its assets' directory is the page's build),
// and the kit's own plug-in for the virtual modules and the checks of design §2.2.
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { KIT_PREVIEW } from "@demo-factory/interfaces";
import { integra } from "./integra/vite.ts";

// In the Studio's preview, and only there, the app's `AI` is the Studio's (KIT_PREVIEW; design §13, row 5): a Workers
// AI binding would need a Cloudflare token inside the sandbox. Built or deployed, the app has the real binding.
export default defineConfig(({ command }) => ({
  plugins: [
    integra(),
    react(),
    cloudflare(
      command === "serve" && process.env[KIT_PREVIEW.flag] === "1"
        ? {
            remoteBindings: false,
            config: (worker) => {
              // One name while the Studio runs it, whatever the app is named: the local store is kept under the
              // Worker's name, and a rename would otherwise start the preview on an empty one.
              worker.name = "preview";
              delete worker.ai;
              worker.services = [...(worker.services ?? []), { binding: "AI", service: "integra-preview-model" }];
            },
            auxiliaryWorkers: [
              {
                config: { name: "integra-preview-model", main: "./integra/preview/model.ts", compatibility_date: "2026-09-17" },
                devOnly: true,
              },
            ],
          }
        : {},
    ),
  ],
}));
